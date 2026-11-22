import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { submitReview } from "@/lib/review/submit";

const DECISION = "00000000-0000-4000-8000-0000000000aa";
const REVIEW_ID = "00000000-0000-4000-8000-0000000000dd";
const UNKNOWN_RESULT = "確認の記録結果を取得できませんでした。記録済みの可能性があります";
const SENTINEL = "LEAK_SENTINEL_5c2e18";

function fakeClient(result: { data: unknown; error: { message: string; code?: string } | null }) {
  const rpc = vi.fn(async () => result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("submitReview", () => {
  it("record_human_review を担当者の権限で呼ぶ（確認者は渡さない）", async () => {
    const { client, rpc } = fakeClient({ data: REVIEW_ID, error: null });
    const result = await submitReview(client, {
      decisionId: DECISION,
      action: "approve",
      finalEntry: null,
      reason: null,
      reviewSeconds: 5,
      bulk: false,
    });
    expect(result).toEqual({ ok: true, reviewId: REVIEW_ID });
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
    const { client } = fakeClient({ data: null, error: { message: "この明細はすでに確認済みです（approved）", code: "P0001" } });
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

  describe("保留の重複の拒否（record_human_review の既知の拒否）", () => {
    const HOLD_ALREADY = "この明細はすでに保留中です。管理者の確認を待ってください";
    const holdInput = { decisionId: DECISION, action: "hold", finalEntry: null, reason: "請求書の到着待ち", reviewSeconds: 45, bulk: false } as const;

    it("文言とP0001の組が完全に一致したときだけ、安全な拒否として画面へ返す", async () => {
      const { client, rpc } = fakeClient({ data: null, error: { message: HOLD_ALREADY, code: "P0001" } });
      await expect(submitReview(client, holdInput)).resolves.toEqual({ ok: false, error: HOLD_ALREADY });
      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it.each(["23505", "42501", "P0002", "XX000"])("同じ文言でもSQLSTATEが違えば（%s）既知の拒否にせず、固定文のエラーを投げる", async (code) => {
      const { client } = fakeClient({ data: null, error: { message: HOLD_ALREADY, code } });
      const failure = await submitReview(client, holdInput).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("確認の記録結果を取得できませんでした。記録済みの可能性があります");
    });

    it.each(["この明細はすでに保留中です", "この明細はすでに保留中です。管理者の確認を待ってください。", "すでに保留", "internal: この明細はすでに保留中です。管理者の確認を待ってください"])(
      "P0001でも文言が違えば（%s）既知の拒否にせず、固定文のエラーを投げる",
      async (message) => {
        const { client } = fakeClient({ data: null, error: { message, code: "P0001" } });
        const failure = await submitReview(client, holdInput).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).not.toContain("保留");
      },
    );

    it("まとめて承認の既存の拒否（保留中の明細は不可）は変わらず返す", async () => {
      const message = "保留中の明細はまとめて承認できません。1件ずつ確認してください";
      const { client } = fakeClient({ data: null, error: { message, code: "P0001" } });
      const result = await submitReview(client, { decisionId: DECISION, action: "approve", finalEntry: null, reason: null, reviewSeconds: 1, bulk: true });
      expect(result).toEqual({ ok: false, error: message });
    });
  });

  describe("成功結果の検証（record_human_review は uuid を返す）", () => {
    const approveInput = { decisionId: DECISION, action: "approve", finalEntry: null, reason: null, reviewSeconds: 1, bulk: false } as const;
    const malformed: [string, unknown][] = [
      ["空文字", ""],
      ["空白のみ", "   "],
      ["旧モックの文字列", "rev-1"],
      ["UUID の前後に空白", ` ${REVIEW_ID} `],
      ["UUID の後ろに文字", `${REVIEW_ID}x`],
      ["UUID の途中が欠けた", REVIEW_ID.slice(0, -1)],
      ["秘密を含む文字列", SENTINEL],
      ["null", null],
      ["undefined", undefined],
      ["数値", 123],
      ["真偽値", true],
      ["空配列", []],
      ["UUID の配列", [REVIEW_ID]],
      ["空オブジェクト", {}],
      ["UUID を含むオブジェクト", { id: REVIEW_ID, note: SENTINEL }],
    ];

    it.each(malformed)("不正な成功結果（%s）は固定文のエラーを投げ、再試行せず、内容を漏らさない", async (_label, data) => {
      const { client, rpc } = fakeClient({ data, error: null });
      const failure = await submitReview(client, approveInput).then(
        (value) => {
          throw new Error(`reject されるはずが解決した: ${JSON.stringify(value)}`);
        },
        (e: unknown) => e,
      );
      expect(failure).toBeInstanceOf(Error);
      const e = failure as Error;
      expect(e.message).toBe(UNKNOWN_RESULT);
      expect(e.cause).toBeUndefined();
      expect([e.name, e.message, e.stack ?? "", JSON.stringify(e, Object.getOwnPropertyNames(e))].join("\n")).not.toContain(SENTINEL);
      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it("正しい UUID なら成功し、RPC は 1 回だけ呼ぶ", async () => {
      const { client, rpc } = fakeClient({ data: REVIEW_ID, error: null });
      await expect(submitReview(client, approveInput)).resolves.toEqual({ ok: true, reviewId: REVIEW_ID });
      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it("error があれば data が不正でも見ず、既知の拒否は従来どおり ok:false", async () => {
      const message = "より新しい仕訳候補があります。画面を更新してください";
      const { client } = fakeClient({ data: "", error: { message, code: "P0001" } });
      await expect(submitReview(client, approveInput)).resolves.toEqual({ ok: false, error: message });
    });
  });

  it.each([null, "", "  ", "　\n"])("保留の理由が空（%j）なら DB を呼ばずに拒否する", async (reason) => {
    const { client, rpc } = fakeClient({ data: "rev-1", error: null });
    const result = await submitReview(client, { decisionId: DECISION, action: "hold", finalEntry: null, reason, reviewSeconds: 1, bulk: false });
    expect(result).toEqual({ ok: false, error: "保留の理由を入力してください" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
