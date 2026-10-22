-- CSV の形式と口座の種類の照合を、DB の取込関数でも行う。
-- アプリ側（src/lib/statements/import.ts）の検査だけでは、担当者が RPC を直接呼べば迂回できる。
-- 実結合の確認（2026-10-21）で、銀行 CSV をカードの口座に取り込めて、正しい口座で取り込み直した明細が
-- 二重に登録された（重複キーが口座ごとのため）。
-- 既存のマイグレーションは書き換えず、関数を置き換える（create or replace は権限を引き継ぐ）。

-- CSV の形式ごとに取り込める口座の種類。src/lib/statements/formats.ts の walletKind と同じ内容に保つ
-- （ユニットテスト tests/unit/statements.test.ts で突き合わせる）。未対応の形式は null。
create function public.statement_csv_format_wallet_kind(p_csv_format text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_csv_format
    when 'bank_generic' then 'bank_account'
    when 'card_generic' then 'credit_card'
  end;
$$;
revoke all on function public.statement_csv_format_wallet_kind(text) from public, anon, authenticated;

create or replace function public.import_bank_statement(
  p_customer_id uuid,
  p_wallet_id uuid,
  p_source text,
  p_file_name text,
  p_csv_format text,
  -- [{ "txn_date": "2026-10-01", "amount": 1000, "direction": "expense",
  --    "description": "...", "balance": 12345 | null, "dedupe_key": "..." }]
  p_rows jsonb,
  p_source_row_count integer,
  -- [{ "line": 12, "reason": "金額が0" }]
  p_ignored_rows jsonb
)
returns table (
  import_id uuid,
  inserted_count integer,
  skipped_duplicate_count integer,
  suspected_duplicate_count integer,
  income_total bigint,
  expense_total bigint,
  inserted_amount_total bigint,
  skipped_amount_total bigint,
  suspected_amount_total bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_import_id uuid;
  v_wallet_kind text;
  v_format_kind text;
  v_total integer;
  v_income bigint;
  v_expense bigint;
  v_skipped integer;
  v_skipped_amount bigint;
  v_suspected integer;
  v_suspected_amount bigint;
  v_inserted integer;
  v_inserted_amount bigint;
begin
  perform public.assert_can_import(p_customer_id);

  -- 口座はその顧客のものであること、CSV の形式が口座の種類に合うこと（明細を1件も登録する前に確かめる）
  select w.kind into v_wallet_kind from public.wallets w where w.id = p_wallet_id and w.customer_id = p_customer_id;
  if v_wallet_kind is null then
    raise exception '口座が見つかりません' using errcode = 'no_data_found';
  end if;
  v_format_kind := public.statement_csv_format_wallet_kind(p_csv_format);
  if v_format_kind is null then
    raise exception '未対応の CSV 形式です: %', coalesce(p_csv_format, '(なし)');
  end if;
  if v_format_kind <> v_wallet_kind then
    raise exception '選んだ口座と CSV の形式が合っていません（% の形式は % の口座にだけ取り込めます）', p_csv_format, v_format_kind;
  end if;

  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_typeof(p_ignored_rows) is distinct from 'array' then
    raise exception 'p_rows and p_ignored_rows must be JSON arrays';
  end if;
  v_total := jsonb_array_length(p_rows);
  if (select count(distinct r ->> 'dedupe_key') from jsonb_array_elements(p_rows) as r) <> v_total then
    raise exception '同じファイルの中で重複キーが重なっています';
  end if;

  select coalesce(sum(r.amount) filter (where r.direction = 'income'), 0),
         coalesce(sum(r.amount) filter (where r.direction = 'expense'), 0)
  into v_income, v_expense
  from jsonb_to_recordset(p_rows) as r(amount bigint, direction text);

  -- 取込済みと同じキー: 残高があれば同じ取引として読み飛ばし、なければ重複の疑い
  select count(*) filter (where r.balance is not null), coalesce(sum(r.amount) filter (where r.balance is not null), 0),
         count(*) filter (where r.balance is null), coalesce(sum(r.amount) filter (where r.balance is null), 0)
  into v_skipped, v_skipped_amount, v_suspected, v_suspected_amount
  from jsonb_to_recordset(p_rows) as r(amount bigint, balance bigint, dedupe_key text)
  join public.bank_transactions existing
    on existing.customer_id = p_customer_id and existing.dedupe_key = r.dedupe_key;

  v_inserted := v_total - v_skipped - v_suspected;
  v_inserted_amount := v_income + v_expense - v_skipped_amount - v_suspected_amount;

  -- 件数・金額を先に数えて取込記録に残す（取込記録は後から更新しない）
  insert into public.statement_imports
    (customer_id, wallet_id, source, file_name, csv_format, imported_by, status,
     source_row_count, row_count, inserted_count, skipped_duplicate_count, suspected_duplicate_count, ignored_rows,
     income_total, expense_total, inserted_amount_total, skipped_amount_total, suspected_amount_total)
  values
    (p_customer_id, p_wallet_id, p_source, p_file_name, p_csv_format, auth.uid(), 'completed',
     p_source_row_count, v_total, v_inserted, v_skipped, v_suspected, p_ignored_rows,
     v_income, v_expense, v_inserted_amount, v_skipped_amount, v_suspected_amount)
  returning id into v_import_id;

  with incoming as (
    select r.*, existing.id as existing_id
    from jsonb_to_recordset(p_rows) as r(
      txn_date date, amount bigint, direction text, description text, balance bigint, dedupe_key text
    )
    left join public.bank_transactions existing
      on existing.customer_id = p_customer_id and existing.dedupe_key = r.dedupe_key
  ),
  new_rows as (
    insert into public.bank_transactions
      (customer_id, wallet_id, import_id, txn_date, amount, direction, description, balance, dedupe_key)
    select p_customer_id, p_wallet_id, v_import_id, txn_date, amount, direction, description, balance, dedupe_key
    from incoming
    where existing_id is null
    returning 1
  ),
  -- 重複の疑い: キーは取込ごとに変えて一意にし、元の明細を指しておく
  suspected_rows as (
    insert into public.bank_transactions
      (customer_id, wallet_id, import_id, txn_date, amount, direction, description, balance, dedupe_key,
       status, duplicate_of_id)
    select p_customer_id, p_wallet_id, v_import_id, txn_date, amount, direction, description, balance,
           dedupe_key || ':suspected:' || v_import_id, 'duplicate_suspected', existing_id
    from incoming
    where existing_id is not null and balance is null
    returning 1
  )
  select (select count(*) from new_rows) into v_total;

  -- 先に数えた件数と実際に登録した件数が違えば（同時に同じ明細を取り込んだ等）、全体を取り消す
  if v_total <> v_inserted then
    raise exception '取込中に明細が変わりました。もう一度取り込んでください（想定 %、登録 %）', v_inserted, v_total;
  end if;

  return query select v_import_id, v_inserted, v_skipped, v_suspected,
    v_income, v_expense, v_inserted_amount, v_skipped_amount, v_suspected_amount;
end;
$$;
