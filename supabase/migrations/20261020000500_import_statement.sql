-- 明細の取込（CSV アップロード1回分）を1トランザクションで登録する。
-- security invoker なので、呼び出した担当者の RLS がそのまま効く（担当外の顧客には登録できない）。
--
-- 同じ dedupe_key の明細がすでにあるとき:
--   - 残高がある行は、残高まで一致しているので同じ取引とみなして読み飛ばす
--   - 残高がない行（カード明細など）は、同日・同額・同摘要の別取引と区別できないので捨てず、
--     「重複の疑い」として登録し、人が「別の取引」か「重複」かを決める（resolve_suspected_duplicate）

create function public.import_bank_statement(
  p_customer_id uuid,
  p_wallet_id uuid,
  p_source text,
  p_file_name text,
  p_csv_format text,
  -- [{ "txn_date": "2026-10-01", "amount": 1000, "direction": "expense",
  --    "description": "...", "balance": 12345 | null, "dedupe_key": "..." }]
  p_rows jsonb
)
returns table (import_id uuid, inserted_count integer, skipped_duplicate_count integer, suspected_duplicate_count integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_import_id uuid;
  v_total integer;
  v_skipped integer;
  v_suspected integer;
  v_inserted integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;
  v_total := jsonb_array_length(p_rows);
  if (select count(distinct r ->> 'dedupe_key') from jsonb_array_elements(p_rows) as r) <> v_total then
    raise exception '同じファイルの中で重複キーが重なっています';
  end if;

  select count(*) filter (where r.balance is not null), count(*) filter (where r.balance is null)
  into v_skipped, v_suspected
  from jsonb_to_recordset(p_rows) as r(balance bigint, dedupe_key text)
  join public.bank_transactions existing
    on existing.customer_id = p_customer_id and existing.dedupe_key = r.dedupe_key;

  -- 件数を先に数えて取込記録に残す（取込記録は後から更新しない）
  insert into public.statement_imports
    (customer_id, wallet_id, source, file_name, csv_format, imported_by, row_count,
     skipped_duplicate_count, suspected_duplicate_count)
  values
    (p_customer_id, p_wallet_id, p_source, p_file_name, p_csv_format, auth.uid(), v_total, v_skipped, v_suspected)
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
  select (select count(*) from new_rows) into v_inserted;

  return query select v_import_id, v_inserted, v_skipped, v_suspected;
end;
$$;

revoke all on function public.import_bank_statement(uuid, uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.import_bank_statement(uuid, uuid, text, text, text, jsonb) to authenticated, service_role;
