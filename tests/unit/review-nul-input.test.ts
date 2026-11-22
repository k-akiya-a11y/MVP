import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { submitDuplicateResolution, submitReview, type ReviewInput } from "@/lib/review/submit";

// 実装前の期待は docs/reviews/2026-11-06-review-nul-input.md。合成データのみ、Supabase はモック。
const DECISION = "00000000-0000-4000-8000-0000000000aa";
const BANK_TX = "00000000-0000-4000-8000-0000000000bb";
const REVIEW_ID = "00000000-0000-4000-8000-0000000000dd";
const UNKNOWN_RESULT = "確認の記録結果を取得できませんでした。記録済みの可能性があります";
const SENTINEL = "LEAK_SENTINEL_9a41f7";
const NUL = "\u0000";

const DESCRIPTION_NUL_ERROR = "摘要に NUL（U+0000）が含まれているため記録できません";
const REASON_NUL_ERROR = "理由に NUL（U+0000）が含まれているため記録できません";

function fakeClient(result: { data: unknown; error: { message: string; code?: string } | null } = { data: REVIEW_ID, error: null }) {
  const rpc = vi.fn(async () => result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const entry = (description: string) => ({ account_item_id: 1, tax_code: 1, partner_id: null, item_id: null, section_id: null, tag_ids: [], description });
const review = (over: Partial<ReviewInput>): ReviewInput => ({ decisionId: DECISION, action: "approve", finalEntry: null, reason: null, reviewSeconds: 3, bulk: false, ...over });

/** 返った error に、NUL（実物・\u0000 表記）も目印文字列も残っていないこと */
function expectSafe(error: string) {
  expect(error).not.toContain(NUL);
  expect(error).not.toContain("\\u0000");
  expect(error).not.toContain(SENTINEL);
}

const nulPositions: [string, string][] = [
  ["末尾", `交通費${SENTINEL}${NUL}`],
  ["途中", `交通${NUL}費${SENTINEL}`],
  ["先頭", `${NUL}${SENTINEL}交通費`],
  ["NUL だけ", NUL],
];

describe("submitReview: finalEntry.description の NUL", () => {
  it.each(nulPositions)("NUL（%s）は ok:false の固定文言で、RPC を呼ばない", async (_label, description) => {
    const { client, rpc } = fakeClient();
    const result = await submitReview(client, review({ action: "correct", finalEntry: entry(description) }));
    expect(result).toEqual({ ok: false, error: DESCRIPTION_NUL_ERROR });
    if (!result.ok) expectSafe(result.error);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("submitReview: reason の NUL", () => {
  const actions: ReviewInput["action"][] = ["hold", "approve", "reject", "correct"];
  const withAction = (action: ReviewInput["action"], reason: string) => review({ action, reason, finalEntry: action === "correct" ? entry("交通費") : null });

  describe.each(actions)("%s", (action) => {
    it.each(nulPositions)("NUL（%s）は ok:false の固定文言で、RPC を呼ばない", async (_label, reason) => {
      const { client, rpc } = fakeClient();
      const result = await submitReview(client, withAction(action, reason));
      expect(result).toEqual({ ok: false, error: REASON_NUL_ERROR });
      if (!result.ok) expectSafe(result.error);
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  it("摘要と理由の両方に NUL があっても、RPC を呼ばず、入力の内容を返さない", async () => {
    const { client, rpc } = fakeClient();
    const result = await submitReview(client, review({ action: "correct", finalEntry: entry(`${SENTINEL}${NUL}`), reason: `${SENTINEL}${NUL}` }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectSafe(result.error);
      expect([DESCRIPTION_NUL_ERROR, REASON_NUL_ERROR]).toContain(result.error);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("submitDuplicateResolution: reason の NUL", () => {
  describe.each(["distinct", "duplicate"] as const)("%s", (resolution) => {
    it.each(nulPositions)("NUL（%s）は ok:false の固定文言で、RPC を呼ばない", async (_label, reason) => {
      const { client, rpc } = fakeClient();
      const result = await submitDuplicateResolution(client, { bankTransactionId: BANK_TX, resolution, reason });
      expect(result).toEqual({ ok: false, error: REASON_NUL_ERROR });
      if (!result.ok) expectSafe(result.error);
      expect(rpc).not.toHaveBeenCalled();
    });
  });
});

describe("NUL がない入力の意味は変えない", () => {
  const valid: [string, string][] = [
    ["日本語", "交通費（出張）ＡＢＣ　テスト"],
    ["改行", "一行目\n二行目\r\n三行目"],
    ["タブ", "確認済み\t問題なし"],
    ["空文字", ""],
  ];

  it.each(valid)("修正の摘要（%s）は加工されずに RPC へ渡る", async (_label, description) => {
    const { client, rpc } = fakeClient();
    const finalEntry = entry(description);
    await expect(submitReview(client, review({ action: "correct", finalEntry }))).resolves.toEqual({ ok: true, reviewId: REVIEW_ID });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_human_review", expect.objectContaining({ p_final_entry: finalEntry }));
  });

  it.each([...valid, ["null", null] as [string, null]])("承認の理由（%s）は加工されずに RPC へ渡る", async (_label, reason) => {
    const { client, rpc } = fakeClient();
    await expect(submitReview(client, review({ action: "approve", reason }))).resolves.toEqual({ ok: true, reviewId: REVIEW_ID });
    expect(rpc).toHaveBeenCalledWith("record_human_review", expect.objectContaining({ p_reason: reason }));
  });

  it.each(valid.filter(([, v]) => v.trim() !== ""))("保留の理由（%s）は加工されずに RPC へ渡る", async (_label, reason) => {
    const { client, rpc } = fakeClient();
    await expect(submitReview(client, review({ action: "hold", reason }))).resolves.toEqual({ ok: true, reviewId: REVIEW_ID });
    expect(rpc).toHaveBeenCalledWith("record_human_review", expect.objectContaining({ p_reason: reason }));
  });

  it.each([null, "", "  ", " 　\n", "\t"])("保留の理由が空・空白のみ（%j）は従来の文言で拒否し、RPC を呼ばない", async (reason) => {
    const { client, rpc } = fakeClient();
    await expect(submitReview(client, review({ action: "hold", reason }))).resolves.toEqual({ ok: false, error: "保留の理由を入力してください" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([...valid, ["null", null] as [string, null]])("重複解決の理由（%s）は加工されずに RPC へ渡る", async (_label, reason) => {
    const { client, rpc } = fakeClient();
    await expect(submitDuplicateResolution(client, { bankTransactionId: BANK_TX, resolution: "distinct", reason })).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("resolve_suspected_duplicate", { p_bank_transaction_id: BANK_TX, p_resolution: "distinct", p_reason: reason });
  });
});

describe("実際の RPC エラーは結果不明のまま（弱めない）", () => {
  const unknownSqlError = { message: `invalid input ${SENTINEL}`, code: "XX000" };

  it("submitReview: NUL のない入力で未知の SQL エラーなら、固定文の Error を投げ、内容を漏らさない", async () => {
    const { client, rpc } = fakeClient({ data: null, error: unknownSqlError });
    const failure = await submitReview(client, review({ action: "hold", reason: "請求書の到着待ち" })).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(UNKNOWN_RESULT);
    expect((failure as Error).message).not.toContain(SENTINEL);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("submitDuplicateResolution: NUL のない入力で未知の SQL エラーなら、固定文の Error を投げる", async () => {
    const { client, rpc } = fakeClient({ data: null, error: unknownSqlError });
    const failure = await submitDuplicateResolution(client, { bankTransactionId: BANK_TX, resolution: "duplicate", reason: "同じ明細" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(UNKNOWN_RESULT);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
