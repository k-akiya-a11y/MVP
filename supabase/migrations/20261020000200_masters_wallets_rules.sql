-- マスタの写し・口座・顧客ルール（設計書5章）

-- freee マスタの写し。AI の出力はこの表にある値（available = true）だけ受け付ける。
-- kind: 勘定科目・取引先・品目・部門・メモタグ・税区分。tax は freee の税区分コードを freee_id に入れる。
create table public.freee_masters (
  customer_id uuid not null references public.customers (id) on delete cascade,
  kind text not null check (kind in ('account_item', 'partner', 'item', 'section', 'tag', 'tax')),
  freee_id bigint not null,
  name text not null,
  -- 科目の既定税区分、取引先のカナ名などマスタ種別ごとの追加属性
  attrs jsonb not null default '{}'::jsonb,
  available boolean not null default true,
  synced_at timestamptz not null default now(),
  primary key (customer_id, kind, freee_id)
);

-- 口座（銀行口座・クレジットカード・その他の決済口座）。freee の口座と対応付ける。
create table public.wallets (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  kind text not null check (kind in ('bank_account', 'credit_card', 'wallet')),
  name text not null,
  freee_walletable_id bigint,
  created_at timestamptz not null default now(),
  unique (customer_id, name),
  unique (customer_id, kind, freee_walletable_id)
);

create index wallets_customer_idx on public.wallets (customer_id);

-- 仕訳ルール（構造化）。rule の行は識別子だけを持ち、中身は版（journal_rule_versions）に持つ。
-- 変更は上書きせず新しい版を追加する。現在の版は version が最大の行。
create table public.journal_rules (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  created_by uuid references public.staff_members (user_id),
  created_at timestamptz not null default now()
);

create index journal_rules_customer_idx on public.journal_rules (customer_id);

create table public.journal_rule_versions (
  rule_id uuid not null references public.journal_rules (id) on delete restrict,
  version integer not null check (version >= 1),
  -- 版を顧客で絞り込めるよう重複して持つ（RLS 用）
  customer_id uuid not null references public.customers (id) on delete restrict,
  -- 小さいほど優先
  priority integer not null default 100,
  status text not null check (status in ('active', 'proposed', 'inactive')),
  source text not null check (source in ('staff', 'correction_history', 'past_entries')),

  -- 条件（指定した項目をすべて満たすと一致。null の項目は条件にしない）
  cond_partner_key text,
  cond_description_keyword text,
  cond_amount_min bigint check (cond_amount_min is null or cond_amount_min >= 0),
  -- 上限は「未満」
  cond_amount_max bigint check (cond_amount_max is null or cond_amount_max > 0),
  cond_wallet_id uuid references public.wallets (id),
  cond_direction text check (cond_direction in ('income', 'expense')),

  -- 処理（freee マスタの ID）
  account_item_id bigint not null,
  tax_code integer not null,
  partner_id bigint,
  item_id bigint,
  section_id bigint,
  tag_ids bigint[] not null default '{}',
  description_template text,

  valid_from date,
  valid_to date,
  created_by uuid references public.staff_members (user_id),
  created_at timestamptz not null default now(),
  primary key (rule_id, version),
  -- 条件が1つもないルールは全取引に一致してしまうので禁止
  check (
    cond_partner_key is not null
    or cond_description_keyword is not null
    or cond_amount_min is not null
    or cond_amount_max is not null
    or cond_wallet_id is not null
    or cond_direction is not null
  ),
  check (cond_amount_min is null or cond_amount_max is null or cond_amount_min < cond_amount_max),
  check (valid_from is null or valid_to is null or valid_from <= valid_to)
);

create index journal_rule_versions_customer_idx on public.journal_rule_versions (customer_id);

-- 文章メモ（AI に渡す例外処理・注意点）。ルールと同じく版で管理する。
create table public.customer_notes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  created_by uuid references public.staff_members (user_id),
  created_at timestamptz not null default now()
);

create index customer_notes_customer_idx on public.customer_notes (customer_id);

create table public.customer_note_versions (
  note_id uuid not null references public.customer_notes (id) on delete restrict,
  version integer not null check (version >= 1),
  customer_id uuid not null references public.customers (id) on delete restrict,
  status text not null check (status in ('active', 'inactive')),
  title text not null,
  body text not null,
  created_by uuid references public.staff_members (user_id),
  created_at timestamptz not null default now(),
  primary key (note_id, version)
);

create index customer_note_versions_customer_idx on public.customer_note_versions (customer_id);

-- 版の customer_id は親と一致させる
create function public.check_version_customer()
returns trigger
language plpgsql
as $$
declare
  parent_customer uuid;
begin
  if tg_table_name = 'journal_rule_versions' then
    select customer_id into parent_customer from public.journal_rules where id = new.rule_id;
  else
    select customer_id into parent_customer from public.customer_notes where id = new.note_id;
  end if;
  if parent_customer is distinct from new.customer_id then
    raise exception 'customer_id of % does not match its parent', tg_table_name;
  end if;
  return new;
end;
$$;

create trigger journal_rule_versions_customer_check
  before insert on public.journal_rule_versions
  for each row execute function public.check_version_customer();

create trigger customer_note_versions_customer_check
  before insert on public.customer_note_versions
  for each row execute function public.check_version_customer();

-- 版は追記専用
create trigger journal_rule_versions_append_only
  before update or delete on public.journal_rule_versions
  for each row execute function public.reject_update_delete();

create trigger customer_note_versions_append_only
  before update or delete on public.customer_note_versions
  for each row execute function public.reject_update_delete();

-- 各ルール・メモの現在の版
create view public.current_journal_rules
with (security_invoker = true) as
select distinct on (rule_id) *
from public.journal_rule_versions
order by rule_id, version desc;

create view public.current_customer_notes
with (security_invoker = true) as
select distinct on (note_id) *
from public.customer_note_versions
order by note_id, version desc;

-- RLS と権限
alter table public.freee_masters enable row level security;
alter table public.wallets enable row level security;
alter table public.journal_rules enable row level security;
alter table public.journal_rule_versions enable row level security;
alter table public.customer_notes enable row level security;
alter table public.customer_note_versions enable row level security;

revoke all on public.freee_masters, public.wallets, public.journal_rules,
  public.journal_rule_versions, public.customer_notes, public.customer_note_versions,
  public.current_journal_rules, public.current_customer_notes
  from anon, authenticated;
revoke update, delete, truncate on public.journal_rule_versions, public.customer_note_versions
  from service_role;

-- マスタの写しはサーバー側の同期処理（service_role）だけが書く
grant select on public.freee_masters, public.wallets, public.journal_rules,
  public.journal_rule_versions, public.customer_notes, public.customer_note_versions,
  public.current_journal_rules, public.current_customer_notes
  to authenticated;
grant insert on public.journal_rules, public.journal_rule_versions,
  public.customer_notes, public.customer_note_versions
  to authenticated;
grant insert, update on public.wallets to authenticated;

create policy freee_masters_select on public.freee_masters
  for select to authenticated using (public.can_access_customer(customer_id));

create policy wallets_select on public.wallets
  for select to authenticated using (public.can_access_customer(customer_id));
create policy wallets_insert on public.wallets
  for insert to authenticated with check (public.can_access_customer(customer_id));
create policy wallets_update on public.wallets
  for update to authenticated
  using (public.can_access_customer(customer_id))
  with check (public.can_access_customer(customer_id));

create policy journal_rules_select on public.journal_rules
  for select to authenticated using (public.can_access_customer(customer_id));
create policy journal_rules_insert on public.journal_rules
  for insert to authenticated
  with check (public.can_access_customer(customer_id) and created_by = auth.uid());

create policy journal_rule_versions_select on public.journal_rule_versions
  for select to authenticated using (public.can_access_customer(customer_id));
create policy journal_rule_versions_insert on public.journal_rule_versions
  for insert to authenticated
  with check (public.can_access_customer(customer_id) and created_by = auth.uid());

create policy customer_notes_select on public.customer_notes
  for select to authenticated using (public.can_access_customer(customer_id));
create policy customer_notes_insert on public.customer_notes
  for insert to authenticated
  with check (public.can_access_customer(customer_id) and created_by = auth.uid());

create policy customer_note_versions_select on public.customer_note_versions
  for select to authenticated using (public.can_access_customer(customer_id));
create policy customer_note_versions_insert on public.customer_note_versions
  for insert to authenticated
  with check (public.can_access_customer(customer_id) and created_by = auth.uid());
