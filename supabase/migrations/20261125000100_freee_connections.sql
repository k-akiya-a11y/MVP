-- freee との接続（読み取りだけ。設計書3章）。顧客ごとに、認可した事業所とトークンを持つ。
--
-- - トークン（アクセス・リフレッシュ）は Supabase Vault に暗号化して保存し、この表には Vault の ID だけを持つ。
--   読み書きは service_role だけが実行できる関数を通す（authenticated・anon は秘密の列も関数も使えない）
-- - リフレッシュトークンは使い捨て（更新のたびに新しくなる）。同時に2つの処理が更新すると片方の新トークンが失われ、
--   連携が切れて再認可が必要になる。そこで更新は「所有者と期限つきのロック」を取った処理だけが行う
--   （begin_freee_token_refresh → freee に更新を依頼 → complete_freee_token_refresh。ロックを取れなかった処理は待って読み直す）
-- - 管理者・担当者が画面で見られるのは、状態・事業所ID・期限などの秘密でない列だけ（担当顧客に限る）
-- - 同期の状態（過去仕訳の取込がどの月まで進んだか）と、同期の実行記録も持つ
-- freee への書込はこのマイグレーションの範囲外（書込は src/lib/execution の承認後の処理だけが行う。未実装）

create table public.freee_connections (
  customer_id uuid primary key references public.customers (id) on delete cascade,
  freee_company_id bigint not null,
  -- active: 使える / needs_reauth: 更新に失敗して再認可が必要
  status text not null check (status in ('active', 'needs_reauth')),
  access_token_secret_id uuid not null,
  refresh_token_secret_id uuid not null,
  access_token_expires_at timestamptz not null,
  connected_by uuid not null references public.staff_members (user_id),
  connected_at timestamptz not null default now(),
  refreshed_at timestamptz,
  -- トークン更新のロック（所有者と期限）。期限が切れたロックは次の処理が引き継げる
  refresh_lock_owner uuid,
  refresh_lock_until timestamptz,
  check ((refresh_lock_owner is null) = (refresh_lock_until is null))
);

-- 同期の進み具合（顧客ごとに1行）
create table public.freee_sync_state (
  customer_id uuid primary key references public.customers (id) on delete cascade,
  masters_synced_at timestamptz,
  -- 過去仕訳（取引）の取込範囲。past_entries_next_month の月から順に past_entries_until の月まで取り込む
  past_entries_from date,
  past_entries_until date,
  past_entries_next_month date,
  past_entries_completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (past_entries_next_month is null or past_entries_next_month = date_trunc('month', past_entries_next_month)::date)
);

-- 同期の実行記録（1回の実行1行）。件数と失敗の理由を残し、黙って落とさない
create table public.freee_sync_runs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  kind text not null check (kind in ('masters', 'past_entries')),
  status text not null check (status in ('running', 'completed', 'failed')),
  -- 種類ごとの件数（例: { "account_item": 120, "unavailable": 3 }、{ "months": 2, "upserted": 80, "skipped_multi_line": 4 }）
  counts jsonb not null default '{}'::jsonb,
  api_calls integer not null default 0 check (api_calls >= 0),
  error text,
  started_by uuid references public.staff_members (user_id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  check ((status = 'running') = (finished_at is null)),
  check (status <> 'failed' or error is not null)
);
create index freee_sync_runs_customer_idx on public.freee_sync_runs (customer_id, started_at desc);

-- 過去仕訳: 銀行の摘要表記・取引先キーをどこから得たか（設計書6章「銀行の摘要表記と freee 上の取引先を両方持つ」）
-- wallet_txn: 同じ口座・日付・金額・入出金の口座明細が1件だけあり、その摘要を使った / partner_name: 取引先名から取引先キーを作った /
-- none: どちらもない。CSV・承認から作った行と、この列より前の行は null
alter table public.past_journal_entries
  add column bank_description_source text check (bank_description_source in ('wallet_txn', 'partner_name', 'none'));

-- RLS と権限
alter table public.freee_connections enable row level security;
alter table public.freee_sync_state enable row level security;
alter table public.freee_sync_runs enable row level security;

revoke all on public.freee_connections, public.freee_sync_state, public.freee_sync_runs from public, anon, authenticated;
-- 画面に出してよい列だけ（Vault の ID・ロックは出さない）
grant select (customer_id, freee_company_id, status, access_token_expires_at, connected_by, connected_at, refreshed_at)
  on public.freee_connections to authenticated;
grant select on public.freee_sync_state, public.freee_sync_runs to authenticated;
-- 書くのはサーバー側の処理（service_role）だけ。接続とトークンは下の関数だけを通す（表への直接の書込は不可）
revoke all on public.freee_connections from service_role;
grant select on public.freee_connections to service_role;
revoke all on public.freee_sync_state, public.freee_sync_runs from service_role;
grant select, insert, update on public.freee_sync_state, public.freee_sync_runs to service_role;

create policy freee_connections_select on public.freee_connections
  for select to authenticated using (public.can_access_customer(customer_id));
create policy freee_sync_state_select on public.freee_sync_state
  for select to authenticated using (public.can_access_customer(customer_id));
create policy freee_sync_runs_select on public.freee_sync_runs
  for select to authenticated using (public.can_access_customer(customer_id));

-- 接続を保存する（OAuth の認可が終わったとき）。既存の接続があれば、同じ Vault の秘密を新しいトークンで上書きする。
-- 認可した事業所が顧客の freee_company_id と違えば拒否する（別の会社のデータを取り込まないため）。接続するのは管理者だけ
create function public.save_freee_connection(
  p_customer_id uuid,
  p_company_id bigint,
  p_access_token text,
  p_refresh_token text,
  p_expires_at timestamptz,
  p_connected_by uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expected bigint;
  v_conn public.freee_connections%rowtype;
begin
  if coalesce(p_access_token, '') = '' or coalesce(p_refresh_token, '') = '' then
    raise exception 'freee のトークンが空です';
  end if;
  select freee_company_id into v_expected from public.customers where id = p_customer_id;
  if not found then
    raise exception '顧客が見つかりません';
  end if;
  if v_expected is null or v_expected <> p_company_id then
    raise exception '認可した freee の事業所が、この顧客の事業所と一致しません';
  end if;
  if not exists (select 1 from public.staff_members where user_id = p_connected_by and role = 'admin') then
    raise exception 'freee との接続は管理者だけが行えます';
  end if;

  select * into v_conn from public.freee_connections where customer_id = p_customer_id for update;
  if found then
    perform vault.update_secret(v_conn.access_token_secret_id, p_access_token);
    perform vault.update_secret(v_conn.refresh_token_secret_id, p_refresh_token);
    update public.freee_connections
    set freee_company_id = p_company_id, status = 'active', access_token_expires_at = p_expires_at,
        connected_by = p_connected_by, connected_at = now(), refreshed_at = null,
        refresh_lock_owner = null, refresh_lock_until = null
    where customer_id = p_customer_id;
  else
    insert into public.freee_connections
      (customer_id, freee_company_id, status, access_token_secret_id, refresh_token_secret_id, access_token_expires_at, connected_by)
    values (
      p_customer_id, p_company_id, 'active',
      vault.create_secret(p_access_token, 'freee_access_token:' || p_customer_id::text, 'freee のアクセストークン'),
      vault.create_secret(p_refresh_token, 'freee_refresh_token:' || p_customer_id::text, 'freee のリフレッシュトークン'),
      p_expires_at, p_connected_by
    );
  end if;
end;
$$;

-- 現在のアクセストークン（期限と状態つき）。接続がなければ0行
create function public.get_freee_access_token(p_customer_id uuid)
returns table (freee_company_id bigint, status text, access_token text, access_token_expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.freee_company_id, c.status, s.decrypted_secret, c.access_token_expires_at
  from public.freee_connections c
  join vault.decrypted_secrets s on s.id = c.access_token_secret_id
  where c.customer_id = p_customer_id;
$$;

-- トークン更新のロックを取る。取れたらリフレッシュトークンを返す。
-- 他の処理がロック中（期限内）なら0行（呼出し側は待ってからアクセストークンを読み直す）。再認可待ち・未接続なら例外。
-- 期限が切れたロックが残っていれば、前の処理は freee に更新を送ったまま結果を保存できなかった（応答の喪失・処理の停止）可能性がある。
-- 使い捨てのリフレッシュトークンを二重に送らないよう、引き継がずに「再認可が必要」にして止める
create function public.begin_freee_token_refresh(p_customer_id uuid, p_owner uuid, p_lock_seconds integer)
returns table (refresh_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.freee_connections%rowtype;
begin
  if p_owner is null then
    raise exception 'p_owner is required';
  end if;
  select * into v_conn from public.freee_connections where customer_id = p_customer_id for update;
  if not found then
    raise exception 'freee と接続していません';
  end if;
  if v_conn.status <> 'active' then
    raise exception 'freee との接続の再認可が必要です';
  end if;
  if v_conn.refresh_lock_owner is not null and v_conn.refresh_lock_until > now() and v_conn.refresh_lock_owner <> p_owner then
    return;
  end if;
  if v_conn.refresh_lock_owner is not null and v_conn.refresh_lock_until <= now() then
    update public.freee_connections
    set status = 'needs_reauth', refresh_lock_owner = null, refresh_lock_until = null
    where customer_id = p_customer_id;
    -- 例外にすると上の update も取り消されるため、状態だけを変えて0行を返す（呼出し側は読み直して再認可待ちを知る）
    return;
  end if;
  update public.freee_connections
  set refresh_lock_owner = p_owner,
      refresh_lock_until = now() + make_interval(secs => least(greatest(coalesce(p_lock_seconds, 0), 10), 300))
  where customer_id = p_customer_id;
  return query select s.decrypted_secret from vault.decrypted_secrets s where s.id = v_conn.refresh_token_secret_id;
end;
$$;

-- 更新の結果を保存し、ロックを外す。ロックの所有者でなければ拒否する（期限切れで他の処理に移ったロックの古い所有者は保存できない）
create function public.complete_freee_token_refresh(
  p_customer_id uuid,
  p_owner uuid,
  p_access_token text,
  p_refresh_token text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.freee_connections%rowtype;
begin
  if coalesce(p_access_token, '') = '' or coalesce(p_refresh_token, '') = '' then
    raise exception 'freee のトークンが空です';
  end if;
  select * into v_conn from public.freee_connections where customer_id = p_customer_id for update;
  if not found or v_conn.refresh_lock_owner is distinct from p_owner then
    raise exception 'トークン更新のロックを持っていません';
  end if;
  perform vault.update_secret(v_conn.access_token_secret_id, p_access_token);
  perform vault.update_secret(v_conn.refresh_token_secret_id, p_refresh_token);
  update public.freee_connections
  set access_token_expires_at = p_expires_at, refreshed_at = now(), status = 'active',
      refresh_lock_owner = null, refresh_lock_until = null
  where customer_id = p_customer_id;
end;
$$;

-- 更新に失敗したとき、ロックを外す。freee が更新を拒んだ（リフレッシュトークンが無効）なら再認可待ちにする。
-- ロックの所有者でなければ何もしない（他の処理の更新を消さない）
create function public.fail_freee_token_refresh(p_customer_id uuid, p_owner uuid, p_needs_reauth boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.freee_connections
  set refresh_lock_owner = null, refresh_lock_until = null,
      status = case when p_needs_reauth then 'needs_reauth' else status end
  where customer_id = p_customer_id and refresh_lock_owner = p_owner;
end;
$$;

revoke all on function public.save_freee_connection(uuid, bigint, text, text, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.get_freee_access_token(uuid) from public, anon, authenticated;
revoke all on function public.begin_freee_token_refresh(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_freee_token_refresh(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.fail_freee_token_refresh(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.save_freee_connection(uuid, bigint, text, text, timestamptz, uuid) to service_role;
grant execute on function public.get_freee_access_token(uuid) to service_role;
grant execute on function public.begin_freee_token_refresh(uuid, uuid, integer) to service_role;
grant execute on function public.complete_freee_token_refresh(uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.fail_freee_token_refresh(uuid, uuid, boolean) to service_role;

-- マスタの写しを freee の内容に合わせる（1回で、全種類まとめて）。
-- - freee にある行は名前・使用可否・freee 由来の属性を更新する。attrs は既存の値に freee の値を重ねる
--   （fixed_asset など、人が付けた属性を消さない）
-- - 今回の freee の応答になかった行は消さずに使用不可（available = false）にする（過去の判断ログが指す値を残すため）
-- p_rows: [{ "kind": "account_item", "freee_id": 101, "name": "...", "available": true, "attrs": { "default_tax_code": 21 } }]
create function public.sync_freee_masters(p_customer_id uuid, p_rows jsonb)
returns table (upserted integer, made_unavailable integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upserted integer;
  v_unavailable integer;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be an array';
  end if;
  if not exists (select 1 from public.freee_connections where customer_id = p_customer_id) then
    raise exception 'freee と接続していない顧客のマスタは同期できません';
  end if;

  with src as (
    select r.kind, r.freee_id, r.name, coalesce(r.available, true) as available, coalesce(r.attrs, '{}'::jsonb) as attrs
    from jsonb_to_recordset(p_rows) as r(kind text, freee_id bigint, name text, available boolean, attrs jsonb)
  ), up as (
    insert into public.freee_masters as m (customer_id, kind, freee_id, name, attrs, available, synced_at)
    select p_customer_id, kind, freee_id, name, attrs, available, now() from src
    on conflict (customer_id, kind, freee_id) do update
      set name = excluded.name, attrs = m.attrs || excluded.attrs, available = excluded.available, synced_at = now()
    returning 1
  )
  select count(*) into v_upserted from up;

  with gone as (
    update public.freee_masters m set available = false, synced_at = now()
    where m.customer_id = p_customer_id and m.available
      and not exists (
        select 1 from jsonb_to_recordset(p_rows) as r(kind text, freee_id bigint)
        where r.kind = m.kind and r.freee_id = m.freee_id
      )
    returning 1
  )
  select count(*) into v_unavailable from gone;

  insert into public.freee_sync_state (customer_id, masters_synced_at) values (p_customer_id, now())
  on conflict (customer_id) do update set masters_synced_at = now(), updated_at = now();

  return query select v_upserted, v_unavailable;
end;
$$;

-- freee の取引から作った過去仕訳を書き込み、取込の進み具合を同じトランザクションで進める（途中で落ちても、進み具合と中身がずれない）。
-- 同じ取引（freee_source_id）は上書きする（freee 側で修正された内容を反映する）。承認から作った過去仕訳には触れない
create function public.apply_freee_past_entries(
  p_customer_id uuid,
  p_rows jsonb,
  p_from date,
  p_until date,
  p_next_month date,
  p_completed boolean
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be an array';
  end if;
  if not exists (select 1 from public.freee_connections where customer_id = p_customer_id) then
    raise exception 'freee と接続していない顧客の過去仕訳は取り込めません';
  end if;

  with src as (
    select * from jsonb_to_recordset(p_rows) as r(
      freee_source_id bigint, entry_date date, amount bigint, direction text, bank_description text,
      bank_description_source text, partner_key text, partner_id bigint, account_item_id bigint, tax_code integer,
      item_id bigint, section_id bigint, tag_ids bigint[], description text
    )
  ), up as (
    insert into public.past_journal_entries as p (
      customer_id, source, freee_source_id, entry_date, amount, direction, bank_description, bank_description_source,
      partner_key, partner_id, account_item_id, tax_code, item_id, section_id, tag_ids, description
    )
    select p_customer_id, 'freee_deal', freee_source_id, entry_date, amount, direction, bank_description, bank_description_source,
           partner_key, partner_id, account_item_id, tax_code, item_id, section_id, coalesce(tag_ids, '{}'), description
    from src
    on conflict (customer_id, source, freee_source_id) where freee_source_id is not null do update
      set entry_date = excluded.entry_date, amount = excluded.amount, direction = excluded.direction,
          bank_description = excluded.bank_description, bank_description_source = excluded.bank_description_source,
          partner_key = excluded.partner_key, partner_id = excluded.partner_id, account_item_id = excluded.account_item_id,
          tax_code = excluded.tax_code, item_id = excluded.item_id, section_id = excluded.section_id,
          tag_ids = excluded.tag_ids, description = excluded.description
    returning 1
  )
  select count(*) into v_n from up;

  insert into public.freee_sync_state (customer_id, past_entries_from, past_entries_until, past_entries_next_month, past_entries_completed_at)
  values (p_customer_id, p_from, p_until, p_next_month, case when p_completed then now() end)
  on conflict (customer_id) do update
    set past_entries_from = excluded.past_entries_from, past_entries_until = excluded.past_entries_until,
        past_entries_next_month = excluded.past_entries_next_month,
        past_entries_completed_at = case when p_completed then now() else public.freee_sync_state.past_entries_completed_at end,
        updated_at = now();
  return v_n;
end;
$$;

revoke all on function public.sync_freee_masters(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.apply_freee_past_entries(uuid, jsonb, date, date, date, boolean) from public, anon, authenticated;
grant execute on function public.sync_freee_masters(uuid, jsonb) to service_role;
grant execute on function public.apply_freee_past_entries(uuid, jsonb, date, date, date, boolean) to service_role;
