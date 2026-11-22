-- 仕訳候補づくりの走査位置と、明細ごとの作業の貸出し（リース）を DB に持つ。
--
-- 問題 1: ジョブは毎回 (txn_date, id) の先頭から最大 1000 件だけを調べていた。先頭側に判定が失敗し続ける明細が
-- 1000 件を超えて溜まると、その後ろの健全な明細は永久に調べられなかった（上限を増やしても溜まり方次第で再発する）。
-- 問題 2: 位置だけだと、未判定が上限未満になって位置が先頭に戻った時点で、別の実行が「AI 呼出し中・記録前」の明細を
-- 再び受け取り、同じ明細に AI を二重に呼んでしまう。
--
-- 変更後:
--   位置: 直前の回で渡した最後の (txn_date, id) を 1 行の表 proposal_scan_cursor に持つ。
--   貸出し: 渡した明細ごとに proposal_leases に (所有者, 期限) を 1 行持つ。期限内の貸出しがある明細は、他の実行に渡さない。
-- claim_pending_proposal_batch が「位置の行ロック → 位置より後ろで貸出しのない未判定を (txn_date, id) 順に最大 p_limit 件選ぶ
-- → 貸出しを記録 → 位置を進める」を 1 トランザクションで行う。
--   - 同時に 2 つの実行が来ても、後の実行は先の実行の確定を待つ。位置は後戻りせず、貸出し中の明細は渡らない（位置の末尾での折返しでも）
--   - 失敗した明細は new のまま残り、貸出しを返す（release_proposal_claims）。位置が末尾まで進んだら先頭に戻り、再び調べる
--   - 実行が落ちて返せなかった貸出しは期限（アプリは 600 秒。関数の最大実行時間 300 秒より長い）で切れ、次の巡回で調べられる
--   - AI を呼ぶ直前に renew_proposal_claim で所有を確かめて期限を延ばす。奪われていれば AI を呼ばない
--   - 記録は record_claimed_ai_decision だけが行う。貸出しの所有者でなければ拒否する（期限が切れて他の実行に奪われた古い実行は記録できない）。
--     記録そのものは従来どおり record_ai_decision が new の明細にだけ許す（保留・履歴は書き換えない）
--   - 1 回に渡す件数は 200 件が上限（DB 側でも制限する）。AI を呼ぶ回数の上限になる
-- 限界: 貸出しの期限が切れたとき、古い実行の AI 呼出しがまだ続いていれば、AI の二重呼出しは起こりうる（外部の呼出しは取り消せない）。
-- その場合でも、古い実行の記録は拒否されるので、判断の記録・状態の遷移は 1 回だけ。期限をアプリの最大実行時間より長くして発生を避ける。
-- 状態の遷移は変えない。追加のみ（既存の表・関数は変更しない）。

create table public.proposal_scan_cursor (
  -- 1 行だけ持つための固定キー
  singleton boolean primary key default true check (singleton),
  -- 直前の回で渡した最後の明細。null は「先頭から」
  last_txn_date date,
  last_id uuid,
  updated_at timestamptz not null default now(),
  check ((last_txn_date is null) = (last_id is null))
);

insert into public.proposal_scan_cursor (singleton) values (true);

-- 明細ごとの作業の貸出し。期限が切れた行は無いものとして扱い、次の貸出しで上書きする。
-- 業務データではなく作業の一時的な状態（判断・承認の記録ではない）なので、追記専用にはしない
create table public.proposal_leases (
  bank_transaction_id uuid primary key references public.bank_transactions (id) on delete cascade,
  owner uuid not null,
  claimed_at timestamptz not null default now(),
  lease_expires_at timestamptz not null
);

-- 新しい表には RLS を付ける。ポリシーは作らない（service_role は RLS を通らず、担当者・anon は一切触れない）
alter table public.proposal_scan_cursor enable row level security;
alter table public.proposal_leases enable row level security;
revoke all on public.proposal_scan_cursor, public.proposal_leases from public, anon, authenticated, service_role;
grant select, update on public.proposal_scan_cursor to service_role;
grant select, insert, update, delete on public.proposal_leases to service_role;

-- 未判定だけを (txn_date, id) 順に引くための部分インデックス
create index bank_transactions_new_scan_idx on public.bank_transactions (txn_date, id) where status = 'new';

create function public.claim_pending_proposal_batch(p_limit integer, p_owner uuid, p_lease_seconds integer)
returns setof public.bank_transactions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 0), 0), 200);
  -- 貸出しの長さは 60 秒〜1 時間に収める
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 0), 60), 3600));
  v_cur public.proposal_scan_cursor%rowtype;
  v_after_date date;
  v_after_id uuid;
  v_last_date date;
  v_last_id uuid;
  v_n integer := 0;
  r public.bank_transactions;
begin
  if p_owner is null then
    raise exception 'p_owner is required';
  end if;
  if v_limit = 0 then
    return;
  end if;

  -- 位置の行ロック。以降の実行はここで待ち、確定後の位置と貸出しを読む
  select * into v_cur from public.proposal_scan_cursor where singleton for update;
  if not found then
    raise exception 'proposal_scan_cursor row is missing';
  end if;
  v_after_date := v_cur.last_txn_date;
  v_after_id := v_cur.last_id;

  -- もう未判定でない明細（記録済・保留など）の貸出しを掃除する
  delete from public.proposal_leases l
  using public.bank_transactions b
  where b.id = l.bank_transaction_id and b.status <> 'new';

  -- 1 回目: 位置より後ろ。位置が先頭でなく 0 件だったときだけ、2 回目として先頭から取り直す
  for v_pass in 1..2 loop
    v_n := 0;
    for r in
      select b.*
      from public.bank_transactions b
      where b.status = 'new'
        and (v_after_date is null or (b.txn_date, b.id) > (v_after_date, v_after_id))
        and not exists (
          select 1 from public.proposal_leases l
          where l.bank_transaction_id = b.id and l.lease_expires_at > now()
        )
      order by b.txn_date, b.id
      limit v_limit
    loop
      -- 期限切れの貸出しだけ上書きする。選んだ後に所有者が延長した貸出しは奪わない（その明細は渡さない）
      insert into public.proposal_leases as l (bank_transaction_id, owner, claimed_at, lease_expires_at)
      values (r.id, p_owner, now(), now() + v_lease)
      on conflict (bank_transaction_id) do update
        set owner = excluded.owner, claimed_at = excluded.claimed_at, lease_expires_at = excluded.lease_expires_at
        where l.lease_expires_at <= now();
      if not found then
        continue;
      end if;
      v_n := v_n + 1;
      v_last_date := r.txn_date;
      v_last_id := r.id;
      return next r;
    end loop;
    exit when v_n > 0 or v_after_date is null;
    v_after_date := null;
    v_after_id := null;
  end loop;

  -- 上限まで取れたなら続きがあり得るので、その位置まで進める。上限未満なら末尾に届いたので先頭に戻す
  if v_n >= v_limit then
    update public.proposal_scan_cursor
    set last_txn_date = v_last_date, last_id = v_last_id, updated_at = now()
    where singleton;
  else
    update public.proposal_scan_cursor
    set last_txn_date = null, last_id = null, updated_at = now()
    where singleton;
  end if;
  return;
end;
$$;

-- AI を呼ぶ直前に、まだ自分の貸出しか（かつ未判定か）を確かめ、期限を延ばす。
-- 期限が切れていても、他の実行に奪われていなければ自分の貸出しとして延長できる。奪われていれば false
create function public.renew_proposal_claim(p_owner uuid, p_bank_transaction_id uuid, p_lease_seconds integer)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 0), 60), 3600));
begin
  update public.proposal_leases l
  set lease_expires_at = now() + v_lease
  where l.bank_transaction_id = p_bank_transaction_id
    and l.owner = p_owner
    and exists (select 1 from public.bank_transactions b where b.id = l.bank_transaction_id and b.status = 'new');
  return found;
end;
$$;

-- 失敗・中止・未着手の明細の貸出しを返す。自分の貸出しだけが消える（他の実行の貸出しには触れない）。返した件数を返す
create function public.release_proposal_claims(p_owner uuid, p_ids uuid[])
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  delete from public.proposal_leases
  where owner = p_owner and bank_transaction_id = any (coalesce(p_ids, '{}'::uuid[]));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- 貸出しの所有者だけが判断を記録できる。貸出しの行を先にロックするので、同時に他の実行が奪っても、
-- 奪った側の確定後に所有者を再評価され、古い実行は拒否される。記録（new だけ許す）は record_ai_decision に任せ、貸出しを消す
create function public.record_claimed_ai_decision(p_owner uuid, p_decision jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_txn uuid := (p_decision ->> 'bank_transaction_id')::uuid;
  v_id uuid;
begin
  perform 1
  from public.proposal_leases
  where bank_transaction_id = v_txn and owner = p_owner
  for update;
  if not found then
    raise exception 'proposal claim for bank transaction % is not held by this owner', v_txn;
  end if;

  v_id := public.record_ai_decision(p_decision);
  delete from public.proposal_leases where bank_transaction_id = v_txn;
  return v_id;
end;
$$;

revoke all on function public.claim_pending_proposal_batch(integer, uuid, integer) from public, anon, authenticated;
revoke all on function public.renew_proposal_claim(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_proposal_claims(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.record_claimed_ai_decision(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.claim_pending_proposal_batch(integer, uuid, integer) to service_role;
grant execute on function public.renew_proposal_claim(uuid, uuid, integer) to service_role;
grant execute on function public.release_proposal_claims(uuid, uuid[]) to service_role;
grant execute on function public.record_claimed_ai_decision(uuid, jsonb) to service_role;
