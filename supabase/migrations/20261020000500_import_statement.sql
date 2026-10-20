-- 明細の取込（CSV アップロード1回分）を1トランザクションで登録する。
-- security invoker なので、呼び出した担当者の RLS がそのまま効く（担当外の顧客には登録できない）。
-- 同じ取引（dedupe_key が同じ）がすでにあれば読み飛ばし、件数を返す。

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
returns table (import_id uuid, inserted_count integer, skipped_duplicate_count integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_import_id uuid;
  v_total integer;
  v_inserted integer;
  v_skipped integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;
  v_total := jsonb_array_length(p_rows);

  -- 取込済みの件数を先に数えて取込記録に残す（取込記録は後から更新しない）
  select count(*) into v_skipped
  from jsonb_array_elements(p_rows) as r
  where exists (
    select 1 from public.bank_transactions t
    where t.customer_id = p_customer_id and t.dedupe_key = r ->> 'dedupe_key'
  );

  insert into public.statement_imports
    (customer_id, wallet_id, source, file_name, csv_format, imported_by, row_count, skipped_duplicate_count)
  values
    (p_customer_id, p_wallet_id, p_source, p_file_name, p_csv_format, auth.uid(), v_total, v_skipped)
  returning id into v_import_id;

  with incoming as (
    select *
    from jsonb_to_recordset(p_rows) as r(
      txn_date date, amount bigint, direction text, description text, balance bigint, dedupe_key text
    )
  ),
  ins as (
    insert into public.bank_transactions
      (customer_id, wallet_id, import_id, txn_date, amount, direction, description, balance, dedupe_key)
    select p_customer_id, p_wallet_id, v_import_id, txn_date, amount, direction, description, balance, dedupe_key
    from incoming
    on conflict (customer_id, dedupe_key) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  return query select v_import_id, v_inserted, v_total - v_inserted;
end;
$$;

revoke all on function public.import_bank_statement(uuid, uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.import_bank_statement(uuid, uuid, text, text, text, jsonb) to authenticated, service_role;
