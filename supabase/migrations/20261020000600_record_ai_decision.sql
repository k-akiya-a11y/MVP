-- AI判断を記録し、明細の状態を「候補作成済」にする（1トランザクション）。
-- サーバー側の判定処理（service_role）だけが呼ぶ。担当者は呼べない。

create function public.record_ai_decision(p_decision jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_txn uuid := (p_decision ->> 'bank_transaction_id')::uuid;
  v_customer uuid := (p_decision ->> 'customer_id')::uuid;
begin
  -- 承認済・登録済・却下の明細には新しい判断を付けない
  perform 1 from public.bank_transactions
  where id = v_txn and customer_id = v_customer and status in ('new', 'proposed', 'on_hold')
  for update;
  if not found then
    raise exception 'bank transaction % is not waiting for a proposal', v_txn;
  end if;

  insert into public.ai_decisions (
    customer_id, bank_transaction_id, transaction_snapshot, proposal, confidence, confidence_breakdown,
    rule_versions_used, note_versions_used, past_entry_ids, ai_output, ai_reason, ai_unknowns,
    model, prompt_version, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_micros
  )
  select
    v_customer, v_txn, d.transaction_snapshot, d.proposal, d.confidence, d.confidence_breakdown,
    coalesce(d.rule_versions_used, '[]'::jsonb), coalesce(d.note_versions_used, '[]'::jsonb),
    coalesce(d.past_entry_ids, '{}'), d.ai_output, d.ai_reason, coalesce(d.ai_unknowns, '{}'),
    d.model, d.prompt_version, d.input_tokens, d.output_tokens, d.cache_read_tokens, d.cache_write_tokens, d.cost_usd_micros
  from jsonb_populate_record(null::public.ai_decisions, p_decision) as d
  returning id into v_id;

  update public.bank_transactions set status = 'proposed' where id = v_txn;
  return v_id;
end;
$$;

revoke all on function public.record_ai_decision(jsonb) from public, anon, authenticated;
grant execute on function public.record_ai_decision(jsonb) to service_role;
