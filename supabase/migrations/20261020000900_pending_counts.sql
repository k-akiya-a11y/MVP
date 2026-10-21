-- トップ画面の残件数。明細を1行ずつ読むと 1,000 行の上限で黙って欠けるので、DB で数える。
-- security_invoker なので、担当者には担当顧客の件数だけが返る（RLS）。
create view public.pending_transaction_counts
with (security_invoker = true)
as
select customer_id, status, count(*)::integer as count
from public.bank_transactions
where status in ('new', 'proposed', 'on_hold', 'duplicate_suspected')
group by customer_id, status;

revoke all on public.pending_transaction_counts from anon, authenticated;
grant select on public.pending_transaction_counts to authenticated;
