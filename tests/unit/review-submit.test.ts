import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { submitReview } from "@/lib/review/submit";

const DECISION = "00000000-0000-4000-8000-0000000000aa";

function fakeClient(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(async () => result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("submitReview", () => {
  it("record_human_review を担当者の権限で呼ぶ（確認者は渡さない）", async () => {
    const { client, rpc } = fakeClient({ data: "rev-1", error: null });
    const result = await submitReview(client, {
      decisionId: DECISION,
      action: "approve",
      finalEntry: null,
      reason: null,
      reviewSeconds: 5,
      bulk: false,
    });
    expect(result).toEqual({ ok: true, reviewId: "rev-1" });
    expect(rpc).toHaveBeenCalledWith("record_human_review", {
      p_ai_decision_id: DECISION,
      p_action: "approve",
      p_final_entry: null,
      p_reason: null,
      p_review_seconds: 5,
      p_bulk: false,
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("reviewer");
  });

  it("修正以外で確定内容を送ったら呼ばない", async () => {
    const { client, rpc } = fakeClient({ data: "x", error: null });
    const result = await submitReview(client, {
      decisionId: DECISION,
      action: "approve",
      finalEntry: { account_item_id: 1, tax_code: 1, partner_id: null, item_id: null, section_id: null, tag_ids: [], description: "" },
      reason: null,
      reviewSeconds: 1,
      bulk: false,
    });
    expect(result.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("DB のエラーをそのまま返す", async () => {
    const { client } = fakeClient({ data: null, error: { message: "この明細はすでに確認済みです（approved）" } });
    const result = await submitReview(client, {
      decisionId: DECISION,
      action: "hold",
      finalEntry: null,
      reason: "顧客に確認中",
      reviewSeconds: 1,
      bulk: false,
    });
    expect(result).toEqual({ ok: false, error: "この明細はすでに確認済みです（approved）" });
  });

  it.each([null, "", "  ", "　\n"])("保留の理由が空（%j）なら DB を呼ばずに拒否する", async (reason) => {
    const { client, rpc } = fakeClient({ data: "rev-1", error: null });
    const result = await submitReview(client, { decisionId: DECISION, action: "hold", finalEntry: null, reason, reviewSeconds: 1, bulk: false });
    expect(result).toEqual({ ok: false, error: "保留の理由を入力してください" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
