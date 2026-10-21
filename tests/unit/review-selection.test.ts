import { describe, expect, it } from "vitest";
import type { ReviewItem } from "@/lib/review/queue";
import { bulkApprovalTargets } from "@/lib/review/selection";

function item(decisionId: string, confidence: ReviewItem["confidence"], status: ReviewItem["txn"]["status"]): ReviewItem {
  return {
    decisionId,
    decidedAt: "2026-10-20T00:00:00Z",
    txn: { id: `t-${decisionId}`, date: "2026-10-27", amount: 9020, direction: "expense", description: "ｻﾝﾌﾟﾙﾂｳｼﾝ", walletName: "", status },
    confidence,
    proposal: null,
    reasons: [],
    forcedLow: [],
    checks: [],
    rule: null,
    past: { matchType: "none", total: 0, majorityShare: null },
    aiReason: null,
    unknowns: [],
    aiUsed: false,
    pastExamples: [],
  };
}

describe("bulkApprovalTargets", () => {
  it("高を複数選択 → 1件を保留 → まとめて承認、で保留した明細は送らない", () => {
    const selected = new Set(["d1", "d2", "d3"]);
    // d2 を保留にした後の一覧（再読込で status が on_hold になる）
    const items = [item("d1", "high", "proposed"), item("d2", "high", "on_hold"), item("d3", "high", "proposed")];
    expect(bulkApprovalTargets(items, selected).map((i) => i.decisionId)).toEqual(["d1", "d3"]);
  });

  it("選択に残った ID でも、一覧にない明細や高以外は送らない", () => {
    const selected = new Set(["d1", "gone", "d4"]);
    const items = [item("d1", "high", "proposed"), item("d4", "medium", "proposed")];
    expect(bulkApprovalTargets(items, selected).map((i) => i.decisionId)).toEqual(["d1"]);
  });
});
