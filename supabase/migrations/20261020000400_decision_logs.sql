-- AI判断ログ・人の確認ログ・実行ログ（設計書8章）
--
-- 3つとも追記専用。UPDATE・DELETE・TRUNCATE は権限で禁止し、さらにトリガーで拒否する。
-- 保存期間は最低7年（帳簿書類の保存期間）なので、顧客削除で連鎖削除しない（on delete restrict）。

-- AI判断（1取引1行）。仕訳候補の中身はこの行が正本。再判定したら新しい行を追加する。
-- freee に登録する取引の ref_number にはこの id を入れる。
create table public.ai_decisions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete restrict,
  bank_transaction_id uuid not null references public.bank_transactions (id) on delete restrict,
  -- 受け取った取引の内容（判定時点の写し。口座番号などは含めない）
  transaction_snapshot jsonb not null,
  -- 提案した処理（科目・税区分・取引先・品目・部門・メモタグ・摘要）。AI が判断できないときは null
  proposal jsonb,
  -- 確信度（プログラムで計算）とその内訳（4つの証拠）
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  confidence_breakdown jsonb not null,
  -- 参照したルールと版 [{ "rule_id": ..., "version": ... }]、文章メモと版
  rule_versions_used jsonb not null default '[]'::jsonb,
  note_versions_used jsonb not null default '[]'::jsonb,
  -- 参照した過去仕訳の ID
  past_entry_ids uuid[] not null default '{}',
  -- AI の回答（検証済み JSON をそのまま）と理由・不明点。AI を呼ばずにルールで決めたときは null
  ai_output jsonb,
  ai_reason text,
  ai_unknowns text[] not null default '{}',
  model text,
  prompt_version text,
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  cache_read_tokens integer check (cache_read_tokens >= 0),
  cache_write_tokens integer check (cache_write_tokens >= 0),
  -- 費用は浮動小数点を避け、100万分の1ドル単位の整数で持つ
  cost_usd_micros bigint check (cost_usd_micros >= 0),
  created_at timestamptz not null default now(),
  check (ai_output is null or (model is not null and prompt_version is not null))
);

create index ai_decisions_txn_idx on public.ai_decisions (bank_transaction_id, created_at desc);
create index ai_decisions_customer_idx on public.ai_decisions (customer_id, created_at desc);

-- 人の確認（1操作1行）
create table public.human_reviews (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete restrict,
  ai_decision_id uuid not null references public.ai_decisions (id) on delete restrict,
  action text not null check (action in ('approve', 'correct', 'hold', 'reject')),
  -- 承認・修正のときの確定内容
  final_entry jsonb,
  -- 修正前後の差分 { 項目: { "before": ..., "after": ... } }
  diff jsonb not null default '{}'::jsonb,
  reason text,
  reviewer_id uuid not null references public.staff_members (user_id) on delete restrict,
  -- 表示から確定までの秒数（KPI「人間作業時間」の補助データ）
  review_seconds integer check (review_seconds >= 0),
  -- 一覧画面でまとめて承認したか
  bulk boolean not null default false,
  created_at timestamptz not null default now(),
  check ((action in ('approve', 'correct')) = (final_entry is not null)),
  check (action = 'correct' or diff = '{}'::jsonb)
);

create index human_reviews_decision_idx on public.human_reviews (ai_decision_id, created_at desc);
create index human_reviews_customer_idx on public.human_reviews (customer_id, created_at desc);

-- 実行（承認済みの処理を外部に書き込んだ結果、1回の実行1行）。
-- src/lib/execution だけが書く。承認・修正の確認記録がない実行はトリガーで拒否する。
create table public.execution_logs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete restrict,
  human_review_id uuid not null references public.human_reviews (id) on delete restrict,
  target text not null check (target in ('freee_deal')),
  status text not null check (status in ('succeeded', 'failed')),
  external_id bigint,
  request_summary jsonb not null default '{}'::jsonb,
  error text,
  executed_at timestamptz not null default now(),
  check (status <> 'succeeded' or external_id is not null)
);

create index execution_logs_review_idx on public.execution_logs (human_review_id);

-- 人の確認: 顧客が AI 判断と一致すること
create function public.check_human_review()
returns trigger
language plpgsql
as $$
declare
  decision_customer uuid;
begin
  select customer_id into decision_customer from public.ai_decisions where id = new.ai_decision_id;
  if decision_customer is distinct from new.customer_id then
    raise exception 'customer_id of human_reviews does not match the ai decision';
  end if;
  return new;
end;
$$;

create trigger human_reviews_check
  before insert on public.human_reviews
  for each row execute function public.check_human_review();

-- 実行: 対応する人の確認が「承認」または「修正」で、顧客が一致すること
create function public.check_execution_approved()
returns trigger
language plpgsql
as $$
declare
  review_action text;
  review_customer uuid;
begin
  select action, customer_id into review_action, review_customer
  from public.human_reviews where id = new.human_review_id;
  if review_action is null or review_action not in ('approve', 'correct') then
    raise exception 'execution requires an approve or correct human review';
  end if;
  if review_customer is distinct from new.customer_id then
    raise exception 'customer_id of execution_logs does not match the human review';
  end if;
  return new;
end;
$$;

create trigger execution_logs_check
  before insert on public.execution_logs
  for each row execute function public.check_execution_approved();

-- 追記専用
create trigger ai_decisions_append_only
  before update or delete on public.ai_decisions
  for each row execute function public.reject_update_delete();
create trigger human_reviews_append_only
  before update or delete on public.human_reviews
  for each row execute function public.reject_update_delete();
create trigger execution_logs_append_only
  before update or delete on public.execution_logs
  for each row execute function public.reject_update_delete();

-- TRUNCATE は行トリガーが動かないので文トリガーで止める
create trigger ai_decisions_no_truncate
  before truncate on public.ai_decisions
  for each statement execute function public.reject_update_delete();
create trigger human_reviews_no_truncate
  before truncate on public.human_reviews
  for each statement execute function public.reject_update_delete();
create trigger execution_logs_no_truncate
  before truncate on public.execution_logs
  for each statement execute function public.reject_update_delete();

-- 承認済みの仕訳候補は過去仕訳に加わる（設計書6章「学習」）。その参照を張る。
alter table public.past_journal_entries
  add constraint past_journal_entries_ai_decision_fk
  foreign key (ai_decision_id) references public.ai_decisions (id) on delete restrict;

-- 各明細の最新の AI 判断と最新の人の確認（承認画面用）
create view public.latest_ai_decisions
with (security_invoker = true) as
select distinct on (bank_transaction_id) *
from public.ai_decisions
order by bank_transaction_id, created_at desc, id;

-- RLS と権限
alter table public.ai_decisions enable row level security;
alter table public.human_reviews enable row level security;
alter table public.execution_logs enable row level security;

revoke all on public.ai_decisions, public.human_reviews, public.execution_logs,
  public.latest_ai_decisions
  from anon, authenticated;
revoke update, delete, truncate on public.ai_decisions, public.human_reviews, public.execution_logs
  from service_role;

grant select on public.ai_decisions, public.human_reviews, public.execution_logs,
  public.latest_ai_decisions
  to authenticated;
-- 人の確認は、ログインした担当者が自分の名前でだけ記録できる
grant insert on public.human_reviews to authenticated;
-- AI 判断と実行の記録はサーバー側（service_role）だけが書く

create policy ai_decisions_select on public.ai_decisions
  for select to authenticated using (public.can_access_customer(customer_id));

create policy human_reviews_select on public.human_reviews
  for select to authenticated using (public.can_access_customer(customer_id));
create policy human_reviews_insert on public.human_reviews
  for insert to authenticated
  with check (public.can_access_customer(customer_id) and reviewer_id = auth.uid());

create policy execution_logs_select on public.execution_logs
  for select to authenticated using (public.can_access_customer(customer_id));
