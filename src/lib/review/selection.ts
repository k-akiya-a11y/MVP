import type { ReviewItem } from "./queue";

/**
 * まとめて承認に送る明細。確信度「高」で候補作成済（保留でない）の明細のうち、選択したものだけ。
 * 選択した後に保留・却下した明細の ID が選択に残っていても、ここで外れる（DB 側でも拒否する）。
 */
export function bulkApprovalTargets(items: readonly ReviewItem[], selected: ReadonlySet<string>): ReviewItem[] {
  return items.filter((i) => i.txn.status === "proposed" && i.confidence === "high" && selected.has(i.decisionId));
}
