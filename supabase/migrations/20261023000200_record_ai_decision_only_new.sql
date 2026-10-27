-- AI判断の記録を、未判定（new）の明細に対する1回だけの状態遷移にする。
--
-- 問題: 従来は new / proposed / on_hold の明細に判断を記録でき、記録のたびに状態を proposed にしていた。
-- 同じ明細を2つのジョブが未判定として読み込んだとき、ジョブ A が記録した後に担当者が保留（on_hold）にしても、
-- 遅れたジョブ B の記録で保留が proposed に戻り、保留の理由が画面から消え、確信度「高」ならまとめて承認できてしまった。
--
-- 変更後: 状態が new の明細だけを proposed に更新し（1文で確認と更新を行う）、更新できなければ判断を記録しない。
--   - 同時に2つの記録が来ても、後の記録は先の記録の確定を待ち、更新の条件（status = 'new'）を再評価されて拒否される
--   - 候補作成済（proposed）への重ねての記録、保留（on_hold）・承認済・却下・登録済への記録はすべて拒否する。
--     既存の判断を置き換えず、保留を解除しない。承認済・却下・登録済は変わらず変更できない
--   - 拒否された判断は記録されない（ai_decisions に行が増えない）。呼出元のジョブには失敗として返り、次回は new の明細だけを読み込む
-- 関数の署名・権限は変えない。

create or replace function public.record_ai_decision(p_decision jsonb)
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
  -- 状態の確認と更新を1文で行う（別々にすると、確認と更新の間に保留などが入りうる）
  update public.bank_transactions
  set status = 'proposed'
  where id = v_txn and customer_id = v_customer and status = 'new';
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

  return v_id;
end;
$$;
