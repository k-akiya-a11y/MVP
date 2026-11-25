-- 段階12（docs/integration-check.md）の照合。読むだけの SQL（書込はしない）。検証用の Supabase の SQL Editor で、まとめて実行してよい。
-- 1行1項目で、ok が true なら合格。false の行があれば、その id と値を連絡する。
-- 前提: 検証用プロジェクトの架空データ（seed と tests/fixtures/verification）だけ。本番では実行しない。
-- 10月の検証で本物のモデルを呼んだ判断ログが残っているプロジェクトを使い回すときは、下の since を段階12の開始時刻（UTC）に書き換える
-- （R-7・R-8 は since 以降の判断ログだけを見る）。新しいプロジェクトならそのままでよい。

with
params as (select timestamptz '1970-01-01 00:00:00+00' as since),
dup_decisions as (            -- 1回の候補生成で、同じ明細に判断ログが2行以上できていないか
  select bank_transaction_id from public.ai_decisions group by bank_transaction_id having count(*) > 1
),
missing_decisions as (        -- 候補作成済・保留・承認・却下なのに判断ログがない明細
  select t.id from public.bank_transactions t
  where t.status in ('proposed', 'on_hold', 'approved', 'rejected')
    and not exists (select 1 from public.ai_decisions d where d.bank_transaction_id = t.id)
),
double_holds as (             -- 同じ判断への保留が2回以上（20261105041046 で DB が拒否するはず）
  select ai_decision_id from public.human_reviews where action = 'hold' group by ai_decision_id having count(*) > 1
),
latest_review as (
  select distinct on (d.bank_transaction_id) d.bank_transaction_id, r.action
  from public.human_reviews r join public.ai_decisions d on d.id = r.ai_decision_id
  order by d.bank_transaction_id, r.created_at desc, r.id
),
status_mismatch as (          -- 明細の状態と、最後の人の確認が合わない
  select t.id from public.bank_transactions t join latest_review l on l.bank_transaction_id = t.id
  where (t.status = 'approved' and l.action not in ('approve', 'correct'))
     or (t.status = 'rejected' and l.action <> 'reject')
     or (t.status = 'on_hold' and l.action <> 'hold')
),
import_mismatch as (          -- 完了した取込の記録と、その取込で実際に入った明細（登録＋重複の疑い。後で人が判断した後の状態も含む）の件数・金額
  select i.id from public.statement_imports i
  left join lateral (
    select count(*) as n, coalesce(sum(t.amount), 0) as amount
    from public.bank_transactions t where t.import_id = i.id
  ) t on true
  where i.status = 'completed'
    and (t.n <> i.inserted_count + i.suspected_duplicate_count
         or t.amount <> i.inserted_amount_total + i.suspected_amount_total)
)
select 'R-1' as id, '同じ明細に判断ログが2行以上' as item, (select count(*) from dup_decisions) as value, '0' as expected,
       (select count(*) from dup_decisions) = 0 as ok
union all select 'R-2', '判断ログのない処理済みの明細', (select count(*) from missing_decisions), '0', (select count(*) from missing_decisions) = 0
union all select 'R-3', '同じ判断への保留が2回以上', (select count(*) from double_holds), '0', (select count(*) from double_holds) = 0
union all select 'R-4', '明細の状態と最後の人の確認が合わない', (select count(*) from status_mismatch), '0', (select count(*) from status_mismatch) = 0
union all select 'R-5', '取込記録と登録された明細の件数・金額が合わない', (select count(*) from import_mismatch), '0', (select count(*) from import_mismatch) = 0
union all select 'R-6', '候補生成の後に残っている貸出し', (select count(*) from public.proposal_leases), '0（ジョブの終了後）',
                 (select count(*) from public.proposal_leases) = 0
union all select 'R-7', '費用が記録された判断ログ（今回は本物の AI を呼ばないので0）',
                 (select count(*) from public.ai_decisions, params where created_at >= since and coalesce(cost_usd_micros, 0) > 0), '0',
                 (select count(*) from public.ai_decisions, params where created_at >= since and coalesce(cost_usd_micros, 0) > 0) = 0
union all select 'R-8', '本物のモデル名が記録された判断ログ（今回は0。偽のモデルは mock/ で始まる）',
                 (select count(*) from public.ai_decisions, params where created_at >= since and model is not null and model not like 'mock/%'), '0',
                 (select count(*) from public.ai_decisions, params where created_at >= since and model is not null and model not like 'mock/%') = 0
order by id;
