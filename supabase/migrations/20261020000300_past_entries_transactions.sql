-- 過去仕訳（設計書6章）と銀行・カード明細（機能①の入力）

-- 過去仕訳。freee から取り込んだ取引・手動仕訳と、承認された仕訳候補を同じ形で持つ。
-- 検索は取引先キー（partner_key）の完全一致 → 類似キーの順に行う。
create table public.past_journal_entries (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  source text not null check (source in ('freee_deal', 'freee_manual_journal', 'approved_proposal')),
  -- freee 側の ID（freee_deal / freee_manual_journal のとき必須）
  freee_source_id bigint,
  -- 承認された仕訳候補から作ったとき、その AI 判断ログの ID
  ai_decision_id uuid,
  entry_date date not null,
  amount bigint not null check (amount > 0),
  direction text not null check (direction in ('income', 'expense')),
  -- 銀行の摘要表記（あれば）と、そこから作った取引先キー
  bank_description text,
  partner_key text,
  partner_id bigint,
  account_item_id bigint not null,
  tax_code integer not null,
  item_id bigint,
  section_id bigint,
  tag_ids bigint[] not null default '{}',
  description text,
  created_at timestamptz not null default now(),
  check (source = 'approved_proposal' or freee_source_id is not null),
  check (source <> 'approved_proposal' or ai_decision_id is not null)
);

create unique index past_journal_entries_freee_uniq
  on public.past_journal_entries (customer_id, source, freee_source_id)
  where freee_source_id is not null;
create index past_journal_entries_partner_key_idx
  on public.past_journal_entries (customer_id, partner_key);

-- 明細の取込単位（CSV アップロード1回、または freee からの取得1回）
create table public.statement_imports (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  wallet_id uuid not null references public.wallets (id),
  source text not null check (source in ('csv', 'freee_wallet_txns')),
  file_name text,
  -- CSV の形式（銀行・カード会社ごとの列の並び）
  csv_format text,
  imported_by uuid references public.staff_members (user_id),
  imported_at timestamptz not null default now(),
  row_count integer not null default 0 check (row_count >= 0),
  skipped_duplicate_count integer not null default 0 check (skipped_duplicate_count >= 0)
);

create index statement_imports_customer_idx on public.statement_imports (customer_id);

-- 銀行・カード明細（1行1取引）。仕訳候補はこの行ごとに作る。
create table public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  wallet_id uuid not null references public.wallets (id),
  import_id uuid not null references public.statement_imports (id),
  txn_date date not null,
  amount bigint not null check (amount > 0),
  direction text not null check (direction in ('income', 'expense')),
  description text not null,
  balance bigint,
  freee_wallet_txn_id bigint,
  -- 重複取込を防ぐキー（口座・日付・金額・入出金・摘要・同日同内容の連番から作る）
  dedupe_key text not null,
  -- 処理状況: 未判定 → 候補作成済 → 承認済 → freee 登録済。保留・却下もある。
  status text not null default 'new'
    check (status in ('new', 'proposed', 'approved', 'registered', 'on_hold', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, dedupe_key)
);

create unique index bank_transactions_freee_uniq
  on public.bank_transactions (customer_id, freee_wallet_txn_id)
  where freee_wallet_txn_id is not null;
create index bank_transactions_status_idx on public.bank_transactions (customer_id, status);

create function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger bank_transactions_touch
  before update on public.bank_transactions
  for each row execute function public.touch_updated_at();

alter table public.past_journal_entries enable row level security;
alter table public.statement_imports enable row level security;
alter table public.bank_transactions enable row level security;

revoke all on public.past_journal_entries, public.statement_imports, public.bank_transactions
  from anon, authenticated;
grant select on public.past_journal_entries, public.statement_imports, public.bank_transactions
  to authenticated;
-- 明細の取込（CSV アップロード）は担当者が行う。過去仕訳の追加・明細の状態変更はサーバー側で行う。
grant insert on public.statement_imports, public.bank_transactions to authenticated;

create policy past_journal_entries_select on public.past_journal_entries
  for select to authenticated using (public.can_access_customer(customer_id));

create policy statement_imports_select on public.statement_imports
  for select to authenticated using (public.can_access_customer(customer_id));
create policy statement_imports_insert on public.statement_imports
  for insert to authenticated
  with check (public.can_access_customer(customer_id) and imported_by = auth.uid());

create policy bank_transactions_select on public.bank_transactions
  for select to authenticated using (public.can_access_customer(customer_id));
create policy bank_transactions_insert on public.bank_transactions
  for insert to authenticated
  with check (public.can_access_customer(customer_id) and status = 'new');
