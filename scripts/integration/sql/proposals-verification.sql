-- 検証用商事株式会社の12件について、最新の判断ログを期待結果（tests/fixtures/verification/README.md、2026-10-22 固定）と並べる。読むだけの SQL。
-- 偽のモデル（段階12）では、確信度・提案は精度の評価に使わない（model が mock/ の行は、通し操作の確認だけに使う）。
-- 本物のモデルでの評価（保留中）は、同じ SQL の結果を docs/integration-results/ に記録して集計する。
-- confidence_ok は確信度の一致、entry_ok は「確定」の7件（B1〜B4・B6・B7・C1）の提案の一致（集計しない件は null）。
-- false_high は「期待が高でないのに高」（誤った高。0件が必須）。

with expected(label, txn_date, direction, amount, exp_confidence, exp_entry) as (
  values
    ('B1', date '2026-10-01', 'expense', 165000, 'medium', '{"account_item_id":105,"tax_code":21,"partner_id":311,"item_id":null,"section_id":401,"tag_ids":[501],"description":"10月分 家賃"}'::jsonb),
    ('B2', date '2026-10-05', 'expense',   5500, 'high',   '{"account_item_id":101,"tax_code":21,"partner_id":314,"item_id":601,"section_id":401,"tag_ids":[],"description":"10月分 クラウド利用料"}'::jsonb),
    ('B3', date '2026-10-10', 'expense',  12340, 'medium', '{"account_item_id":109,"tax_code":21,"partner_id":315,"item_id":null,"section_id":401,"tag_ids":[],"description":"10月分 電気料金"}'::jsonb),
    ('B4', date '2026-10-15', 'expense',    110, 'medium', '{"account_item_id":104,"tax_code":21,"partner_id":null,"item_id":null,"section_id":401,"tag_ids":[],"description":"ATM手数料"}'::jsonb),
    ('B5', date '2026-10-20', 'expense',   5000, 'low',    null),
    ('B6', date '2026-10-27', 'expense',   9020, 'high',   '{"account_item_id":101,"tax_code":21,"partner_id":312,"item_id":null,"section_id":null,"tag_ids":[],"description":"10月分 通信料"}'::jsonb),
    ('B7', date '2026-10-31', 'income',  220000, 'medium', '{"account_item_id":106,"tax_code":31,"partner_id":313,"item_id":null,"section_id":401,"tag_ids":[],"description":"9月分 業務委託料"}'::jsonb),
    ('B8', date '2026-10-31', 'income',   50000, 'low',    null),
    ('C1', date '2026-10-03', 'expense',   2750, 'medium', '{"account_item_id":110,"tax_code":21,"partner_id":null,"item_id":null,"section_id":401,"tag_ids":[],"description":"書籍"}'::jsonb),
    ('C2', date '2026-10-08', 'expense',   3980, 'low',    null),
    ('C3', date '2026-10-12', 'expense', 132000, 'low',    null),
    ('C4', date '2026-10-18', 'expense',   1200, 'low',    null)
),
txns as (
  select t.* from public.bank_transactions t
  where t.customer_id = '10000000-0000-4000-8000-000000000003' and t.status <> 'duplicate'
)
select e.label, t.txn_date, t.description, t.amount, t.status as txn_status,
       d.confidence, e.exp_confidence,
       d.confidence = e.exp_confidence as confidence_ok,
       case when e.exp_entry is null then null else d.proposal = e.exp_entry end as entry_ok,
       (d.confidence = 'high' and e.exp_confidence <> 'high') as false_high,
       d.proposal, d.ai_unknowns, d.model, d.prompt_version,
       d.input_tokens, d.output_tokens, d.cache_read_tokens, d.cost_usd_micros, d.created_at
from expected e
left join txns t on t.txn_date = e.txn_date and t.direction = e.direction and t.amount = e.amount
left join public.latest_ai_decisions d on d.bank_transaction_id = t.id
order by e.label;
