-- 明細の取込記録で、取り込み元と結果の件数・金額を照合できるようにする（共有開発ルール「明細を黙って捨てない」）。
--   - 取込が成功したとき: 読めた行の件数・金額 = 登録 + 読み飛ばし（取込済み） + 重複の疑い
--   - 金額0の行（残高照会など）は取引ではないので登録しないが、行番号と理由を残す
--   - 読めない行があってファイルを取り込まなかったときも、理由と行番号を「失敗」の取込記録として残す
-- 既存のマイグレーションは書き換えず、この変更で列と関数を追加・置き換える。
--
-- 照合の制約を迂回できないよう、担当者が明細と取込記録の表に直接書くことは止め、取込は次の2つの関数だけを通す。
-- 関数は security definer なので、担当者であることと閲覧範囲（can_access_customer）を関数の中で確かめる。

revoke insert on public.statement_imports, public.bank_transactions from authenticated;
drop policy statement_imports_insert on public.statement_imports;
drop policy bank_transactions_insert on public.bank_transactions;

-- 取込を呼べる人か（ログインした担当者で、その顧客を担当している）
create function public.assert_can_import(p_customer_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (select 1 from public.staff_members where user_id = auth.uid()) then
    raise exception 'ログインした担当者だけが明細を取り込めます' using errcode = 'insufficient_privilege';
  end if;
  if not public.can_access_customer(p_customer_id) then
    raise exception '担当外の顧客には明細を取り込めません' using errcode = 'insufficient_privilege';
  end if;
end;
$$;
revoke all on function public.assert_can_import(uuid) from public, anon, authenticated;

alter table public.statement_imports
  add column status text not null default 'completed' check (status in ('completed', 'failed')),
  -- CSV の見出し行より後の行数（空行を除く）。= 読めた行 + 金額0の行 + 読めない行
  add column source_row_count integer check (source_row_count >= 0),
  add column inserted_count integer not null default 0 check (inserted_count >= 0),
  -- 金額0で取引として扱わなかった行 [{ "line": 12, "reason": "..." }]
  add column ignored_rows jsonb not null default '[]'::jsonb,
  -- 読めなかった行 [{ "line": 7, "message": "..." }]（status = failed のとき）
  add column errors jsonb not null default '[]'::jsonb,
  -- 読めた行の金額（円）。入金と出金を分けて持つ
  add column income_total bigint not null default 0 check (income_total >= 0),
  add column expense_total bigint not null default 0 check (expense_total >= 0),
  add column inserted_amount_total bigint not null default 0 check (inserted_amount_total >= 0),
  add column skipped_amount_total bigint not null default 0 check (skipped_amount_total >= 0),
  add column suspected_amount_total bigint not null default 0 check (suspected_amount_total >= 0),
  add constraint statement_imports_reconciled check (
    status = 'failed'
    or (
      row_count = inserted_count + skipped_duplicate_count + suspected_duplicate_count
      and income_total + expense_total = inserted_amount_total + skipped_amount_total + suspected_amount_total
      and (source_row_count is null
           or source_row_count = row_count + jsonb_array_length(ignored_rows) + jsonb_array_length(errors))
    )
  ),
  add constraint statement_imports_failed_has_errors check (
    status = 'completed' or (jsonb_array_length(errors) > 0 and row_count = 0)
  );

drop function public.import_bank_statement(uuid, uuid, text, text, text, jsonb);

create function public.import_bank_statement(
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

revoke all on function public.import_bank_statement(uuid, uuid, text, text, text, jsonb, integer, jsonb) from public, anon;
grant execute on function public.import_bank_statement(uuid, uuid, text, text, text, jsonb, integer, jsonb)
  to authenticated;

-- 読めない行があってファイルを取り込まなかったことを記録する（明細は登録しない）
create function public.record_failed_statement_import(
  p_customer_id uuid,
  p_wallet_id uuid,
  p_source text,
  p_file_name text,
  p_csv_format text,
  p_source_row_count integer,
  -- [{ "line": 7, "message": "日付を読めません" }]
  p_errors jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.assert_can_import(p_customer_id);
  if jsonb_typeof(p_errors) is distinct from 'array' or jsonb_array_length(p_errors) = 0 then
    raise exception '失敗の理由がありません';
  end if;
  insert into public.statement_imports
    (customer_id, wallet_id, source, file_name, csv_format, imported_by, status, source_row_count, row_count, errors)
  values
    (p_customer_id, p_wallet_id, p_source, p_file_name, p_csv_format, auth.uid(), 'failed', p_source_row_count, 0, p_errors)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_failed_statement_import(uuid, uuid, text, text, text, integer, jsonb) from public, anon;
grant execute on function public.record_failed_statement_import(uuid, uuid, text, text, text, integer, jsonb)
  to authenticated;
