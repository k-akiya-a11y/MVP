import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { submitDuplicateResolution, submitReview, type DuplicateResolutionInput, type ReviewInput } from "@/lib/review/submit";

// 人の確認を記録する 2 つの入口（submitReview / submitDuplicateResolution）の「エラーの境界」の回帰テスト。
// DB（RPC）が返したエラー文をそのまま画面へ渡さないことを固定する。架空データ・モックのみ。
// 設計: docs/reviews/2026-11-05-review-error-boundary.md

const SENTINEL = "LEAK_SENTINEL_7f3a91";
const DECISION = "00000000-0000-4000-8000-0000000000aa";
const TXN = "00000000-0000-4000-8000-0000000000bb";

type RpcError = { message: string; code?: string; details?: string | null; hint?: string | null };
type RpcResult = { data: unknown; error: RpcError | null };

type RpcImpl = (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;

function fakeClient(impl: RpcImpl) {
  const rpc = vi.fn<RpcImpl>(impl);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}
const returning = (error: RpcError) => fakeClient(async () => ({ data: null, error }));

const reviewInput = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  decisionId: DECISION,
  action: "approve",
  finalEntry: null,
  reason: null,
  reviewSeconds: 3,
  bulk: false,
  ...over,
});
const duplicateInput = (over: Partial<DuplicateResolutionInput> = {}): DuplicateResolutionInput => ({
  bankTransactionId: TXN,
  resolution: "distinct",
  reason: null,
  ...over,
});

const callers = {
  submitReview: (client: SupabaseClient) => submitReview(client, reviewInput()),
  submitDuplicateResolution: (client: SupabaseClient) => submitDuplicateResolution(client, duplicateInput()),
} as const;
type CallerName = keyof typeof callers;
const CALLER_NAMES = Object.keys(callers) as CallerName[];

/** 例外のメッセージ・名前・スタック・原因・独自プロパティのどこにも秘密が残っていないことを確かめるため、まとめて文字列にする */
function everythingAbout(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const own = JSON.stringify(e, Object.getOwnPropertyNames(e));
  return [e.name, e.message, e.stack ?? "", own, e.cause === undefined ? "" : everythingAbout(e.cause)].join("\n");
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    const value = await promise;
    throw new Error(`reject されるはずが解決した: ${JSON.stringify(value)}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("reject されるはずが解決した")) throw e;
    expect(e).toBeInstanceOf(Error);
    return e as Error;
  }
}

// ---- DB のマイグレーションに実在する、安全な拒否（メッセージ文と SQLSTATE の組） ----
// record_human_review: supabase/migrations/20261020000700_record_human_review.sql
// resolve_suspected_duplicate: supabase/migrations/20261020000800_duplicate_reviews.sql
// 42501 = insufficient_privilege, P0002 = no_data_found, P0001 = 指定なしの raise exception
const NOT_STAFF = { message: "ログインした担当者だけが確認を記録できます", code: "42501" };

const REVIEW_REFUSALS: RpcError[] = [
  NOT_STAFF,
  { message: "仕訳候補が見つかりません", code: "P0002" },
  { message: "保留の理由を入力してください", code: "P0001" },
  { message: "承認・修正・却下は承認者（管理者）だけが行えます。保留にして理由を残してください", code: "42501" },
  { message: "より新しい仕訳候補があります。画面を更新してください", code: "P0001" },
  { message: "まとめて承認できるのは確信度「高」だけです", code: "P0001" },
  { message: "保留中の明細はまとめて承認できません。1件ずつ確認してください", code: "P0001" },
  { message: "提案がないので承認できません。修正として入力してください", code: "P0001" },
  { message: "提案から変更がありません。承認してください", code: "P0001" },
  { message: "勘定科目と税区分は必須です", code: "P0001" },
];

const DUPLICATE_REFUSALS: RpcError[] = [
  NOT_STAFF,
  { message: "明細が見つかりません", code: "P0002" },
  { message: "重複として除外できるのは承認者（管理者）だけです", code: "42501" },
];

// bank_transactions.status の check 制約（20261020000300_past_entries_transactions.sql）の全値
const STATUS_ENUM = ["new", "proposed", "approved", "registered", "on_hold", "rejected", "duplicate_suspected", "duplicate"] as const;

// normalize_final_entry の、値を埋め込むメッセージ（P0001）
const MASTER_KINDS = ["勘定科目", "税区分", "取引先", "品目", "部門", "メモタグ"] as const;

describe("DB が返した想定外のエラーは、画面へ渡さず、サニタイズした Error として reject する", () => {
  const unexpected: { name: string; error: RpcError }[] = [
    {
      name: "内部の SQL エラー（メッセージ・details・hint に内部情報）",
      error: {
        message: `duplicate key value violates unique constraint "human_reviews_pkey" ${SENTINEL}`,
        code: "23505",
        details: `Key (id)=(${SENTINEL}) already exists.`,
        hint: `see public.human_reviews ${SENTINEL}`,
      },
    },
    {
      name: "コードなしの未知のメッセージ",
      error: { message: `relation "public.secret_table" does not exist ${SENTINEL}` },
    },
    {
      name: "通信の失敗（HTML の応答本文に秘密）",
      error: { message: `<html><body>502 Bad Gateway <!-- ${SENTINEL} --></body></html>`, code: "", details: `<pre>${SENTINEL}</pre>`, hint: "" },
    },
    {
      name: "通信の失敗（fetch の失敗文）",
      error: { message: `TypeError: fetch failed: connect ECONNREFUSED 10.0.0.5:5432 ${SENTINEL}`, code: "" },
    },
    {
      name: "コードは安全側だが文面が未知",
      error: { message: `権限がありません ${SENTINEL}`, code: "42501" },
    },
  ];

  describe.each(CALLER_NAMES)("%s", (name) => {
    it.each(unexpected)("$name → 秘密を含まない Error で reject（業務上の拒否 ok:false にしない）", async ({ error }) => {
      const { client, rpc } = returning(error);
      const e = await rejection(callers[name](client));
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(everythingAbout(e)).not.toContain(SENTINEL);
      expect(everythingAbout(e)).not.toContain("<html");
      expect(everythingAbout(e)).not.toContain("public.");
      expect(e.message).not.toBe("");
    });

    it("RPC 自体が Error を投げても（秘密入り）、秘密を含まない Error で reject する", async () => {
      const thrown = Object.assign(new Error(`socket hang up ${SENTINEL}`), { details: SENTINEL });
      const { client } = fakeClient(async () => {
        throw thrown;
      });
      const e = await rejection(callers[name](client));
      expect(everythingAbout(e)).not.toContain(SENTINEL);
      expect(e.message).not.toBe("");
    });

    it("RPC が Error 以外を投げても、秘密を含まない Error で reject する", async () => {
      const { client } = fakeClient(async () => {
        throw `raw string ${SENTINEL}`;
      });
      const e = await rejection(callers[name](client));
      expect(everythingAbout(e)).not.toContain(SENTINEL);
    });
  });

  it("想定外のエラーは「結果不明」であり、成功とも業務上の拒否とも区別して返らない（解決した値に error 文を載せない）", async () => {
    for (const name of CALLER_NAMES) {
      for (const { error } of unexpected) {
        const { client } = returning(error);
        const settled = await callers[name](client).then(
          (value) => ({ resolved: true as const, value }),
          () => ({ resolved: false as const }),
        );
        expect(settled.resolved).toBe(false);
      }
    }
  });
});

describe("DB が実際に返す既知の拒否（文面と SQLSTATE が一致）は、ok:false の業務エラーとして返す", () => {
  it.each(REVIEW_REFUSALS)("submitReview: $code $message", async (refusal) => {
    const { client } = returning(refusal);
    expect(await submitReview(client, reviewInput())).toEqual({ ok: false, error: refusal.message });
  });

  it.each(DUPLICATE_REFUSALS)("submitDuplicateResolution: $code $message", async (refusal) => {
    const { client } = returning(refusal);
    expect(await submitDuplicateResolution(client, duplicateInput())).toEqual({ ok: false, error: refusal.message });
  });

  it.each(STATUS_ENUM)("submitReview: 確認済みの明細（状態 %s）", async (status) => {
    const { client } = returning({ message: `この明細はすでに確認済みです（${status}）`, code: "P0001" });
    expect(await submitReview(client, reviewInput())).toEqual({ ok: false, error: `この明細はすでに確認済みです（${status}）` });
  });

  it.each(STATUS_ENUM)("submitDuplicateResolution: 重複の確認待ちではない明細（状態 %s）", async (status) => {
    const { client } = returning({ message: `この明細は重複の確認待ちではありません（${status}）`, code: "P0001" });
    expect(await submitDuplicateResolution(client, duplicateInput())).toEqual({
      ok: false,
      error: `この明細は重複の確認待ちではありません（${status}）`,
    });
  });

  it("既知の拒否に details / hint が付いていても、返す値に載せない", async () => {
    const refusal = { ...REVIEW_REFUSALS[1]!, details: `Key ${SENTINEL}`, hint: `hint ${SENTINEL}` };
    const { client } = returning(refusal);
    const result = await submitReview(client, reviewInput());
    expect(result).toEqual({ ok: false, error: refusal.message });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});

describe("状態名は実在する値だけ。範囲外・細工された値は reject する", () => {
  const bogus = ["", "approved ", "APPROVED", "unknown", `approved）${SENTINEL}（`, `${SENTINEL}`, "approved|new", "新規"];

  it.each(bogus)("submitReview: 状態 %j", async (status) => {
    const { client } = returning({ message: `この明細はすでに確認済みです（${status}）`, code: "P0001" });
    const e = await rejection(submitReview(client, reviewInput()));
    expect(everythingAbout(e)).not.toContain(SENTINEL);
  });

  it.each(bogus)("submitDuplicateResolution: 状態 %j", async (status) => {
    const { client } = returning({ message: `この明細は重複の確認待ちではありません（${status}）`, code: "P0001" });
    const e = await rejection(submitDuplicateResolution(client, duplicateInput()));
    expect(everythingAbout(e)).not.toContain(SENTINEL);
  });
});

describe("マスタにない値の拒否（値を埋め込む動的メッセージ）は、値を含まない固定文にする", () => {
  const values = ["99887766", "-5", "123456789012"];

  it.each(MASTER_KINDS)("%s: 値を返さず、値が違っても同じ固定文で ok:false", async (kind) => {
    const errors: string[] = [];
    for (const value of values) {
      const { client } = returning({ message: `${kind} ${value} はマスタにありません`, code: "P0001" });
      const result = await submitReview(client, reviewInput());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).not.toContain(value);
      expect(result.error).toContain("マスタ");
      errors.push(result.error);
    }
    expect(new Set(errors).size).toBe(1);
  });

  it.each(MASTER_KINDS)("%s: 文面が似ていても、値が整数でなければ（DB が出さない形）reject する", async (kind) => {
    const { client } = returning({ message: `${kind} ${SENTINEL} はマスタにありません`, code: "P0001" });
    const e = await rejection(submitReview(client, reviewInput()));
    expect(everythingAbout(e)).not.toContain(SENTINEL);
  });

  it("マスタの拒否に細工した文面（後ろに余計な文）が付いていたら reject する", async () => {
    const { client } = returning({ message: `勘定科目 123 はマスタにありません ${SENTINEL}`, code: "P0001" });
    const e = await rejection(submitReview(client, reviewInput()));
    expect(everythingAbout(e)).not.toContain(SENTINEL);
  });

  it("マスタの拒否でも SQLSTATE が違えば reject する", async () => {
    const { client } = returning({ message: "勘定科目 123 はマスタにありません", code: "42501" });
    await rejection(submitReview(client, reviewInput()));
  });

  it("submitDuplicateResolution はマスタの拒否を返さない（その関数の拒否ではない）ので reject する", async () => {
    const { client } = returning({ message: "勘定科目 123 はマスタにありません", code: "P0001" });
    await rejection(submitDuplicateResolution(client, duplicateInput()));
  });
});

describe("文面だけ・コードだけでは通さない（文面と SQLSTATE の両方が実在の組と一致）", () => {
  it.each(REVIEW_REFUSALS)("submitReview: 既知の文面でも SQLSTATE が違えば reject: $message", async (refusal) => {
    for (const code of ["XX000", "23505", "", undefined, refusal.code === "P0001" ? "42501" : "P0001"]) {
      const { client } = returning({ message: refusal.message, code });
      await rejection(submitReview(client, reviewInput()));
    }
  });

  it.each(DUPLICATE_REFUSALS)("submitDuplicateResolution: 既知の文面でも SQLSTATE が違えば reject: $message", async (refusal) => {
    for (const code of ["XX000", "23505", "", undefined, refusal.code === "P0001" ? "42501" : "P0001"]) {
      const { client } = returning({ message: refusal.message, code });
      await rejection(submitDuplicateResolution(client, duplicateInput()));
    }
  });

  it("既知の SQLSTATE でも、文面が既知でなければ reject する（コードだけの許可リストにしない）", async () => {
    for (const code of ["42501", "P0002", "P0001"]) {
      for (const name of CALLER_NAMES) {
        const { client } = returning({ message: `未知の文面 ${SENTINEL}`, code });
        const e = await rejection(callers[name](client));
        expect(everythingAbout(e)).not.toContain(SENTINEL);
      }
    }
  });

  it("文面が既知の文の前後・途中に余計な文字を足したものは reject する", async () => {
    const base = REVIEW_REFUSALS[1]!;
    for (const message of [`${base.message} `, ` ${base.message}`, `${base.message}\n${SENTINEL}`, `${SENTINEL}: ${base.message}`, base.message.slice(0, -1)]) {
      const { client } = returning({ message, code: base.code });
      const e = await rejection(submitReview(client, reviewInput()));
      expect(everythingAbout(e)).not.toContain(SENTINEL);
    }
  });

  it("もう一方の関数だけの拒否は、その関数では reject する（関数ごとに実在の組だけ）", async () => {
    const reviewOnly = REVIEW_REFUSALS.find((r) => r.message === "仕訳候補が見つかりません")!;
    const duplicateOnly = DUPLICATE_REFUSALS.find((r) => r.message === "明細が見つかりません")!;
    await rejection(submitDuplicateResolution(returning(reviewOnly).client, duplicateInput()));
    await rejection(submitReview(returning(duplicateOnly).client, reviewInput()));
  });
});

describe("DB が実際には使わない拒否の文面（起こり得ない内部エラー）は reject する", () => {
  it("unknown action / unknown resolution / final entry must be an object", async () => {
    await rejection(submitReview(returning({ message: "unknown action foo", code: "P0001" }).client, reviewInput()));
    await rejection(submitReview(returning({ message: "final entry must be an object", code: "P0001" }).client, reviewInput()));
    await rejection(submitDuplicateResolution(returning({ message: "unknown resolution foo", code: "P0001" }).client, duplicateInput()));
  });
});

describe("入力検証と成功は従来どおり", () => {
  it("submitReview: 入力が不正なら RPC を呼ばずに ok:false", async () => {
    const { client, rpc } = fakeClient(async () => ({ data: "x", error: null }));
    expect(await submitReview(client, reviewInput({ action: "hold", reason: "　" }))).toEqual({ ok: false, error: "保留の理由を入力してください" });
    expect((await submitReview(client, reviewInput({ decisionId: "not-a-uuid" }))).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("submitDuplicateResolution: 入力が不正なら RPC を呼ばずに ok:false", async () => {
    const { client, rpc } = fakeClient(async () => ({ data: null, error: null }));
    expect((await submitDuplicateResolution(client, duplicateInput({ bankTransactionId: "nope" }))).ok).toBe(false);
    expect((await submitDuplicateResolution(client, duplicateInput({ resolution: "other" as "distinct" }))).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("submitReview: 成功は reviewId を返す", async () => {
    const { client, rpc } = fakeClient(async () => ({ data: "00000000-0000-4000-8000-0000000000dd", error: null }));
    expect(await submitReview(client, reviewInput())).toEqual({ ok: true, reviewId: "00000000-0000-4000-8000-0000000000dd" });
    expect(rpc).toHaveBeenCalledWith("record_human_review", {
      p_ai_decision_id: DECISION,
      p_action: "approve",
      p_final_entry: null,
      p_reason: null,
      p_review_seconds: 3,
      p_bulk: false,
    });
  });

  it("submitDuplicateResolution: 成功は ok:true", async () => {
    const { client, rpc } = fakeClient(async () => ({ data: "00000000-0000-4000-8000-0000000000ee", error: null }));
    expect(await submitDuplicateResolution(client, duplicateInput({ resolution: "duplicate", reason: "同じ取引" }))).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("resolve_suspected_duplicate", {
      p_bank_transaction_id: TXN,
      p_resolution: "duplicate",
      p_reason: "同じ取引",
    });
  });
});

// ---- resolve_suspected_duplicate の成功結果（uuid）の検証 ----
// 設計: docs/reviews/2026-11-05-duplicate-result-validation.md
const UNKNOWN_RESULT = "確認の記録結果を取得できませんでした。記録済みの可能性があります";
const DUP_RESULT_ID = "00000000-0000-4000-8000-0000000000ee";
const RESOLUTIONS = ["distinct", "duplicate"] as const;

describe("submitDuplicateResolution: error なしでも成功結果が uuid でなければ、固定文の Error で reject する", () => {
  const malformed: { label: string; data: unknown }[] = [
    { label: "null", data: null },
    { label: "undefined", data: undefined },
    { label: "空文字", data: "" },
    { label: "空白だけ", data: "   " },
    { label: "全角空白だけ", data: "　" },
    { label: "UUID でない文字列", data: "dup-1" },
    { label: "目印入りの UUID でない文字列", data: `${SENTINEL}-not-a-uuid` },
    { label: "UUID の前後に空白", data: ` ${DUP_RESULT_ID} ` },
    { label: "UUID に文字を足したもの", data: `${DUP_RESULT_ID}${SENTINEL}` },
    { label: "数値", data: 123 },
    { label: "真偽値 true", data: true },
    { label: "真偽値 false", data: false },
    { label: "空配列", data: [] },
    { label: "UUID 入りの配列", data: [DUP_RESULT_ID] },
    { label: "空オブジェクト", data: {} },
    { label: "UUID 入りのオブジェクト", data: { id: DUP_RESULT_ID } },
    { label: "目印入りのオブジェクト", data: { message: SENTINEL, id: SENTINEL } },
  ];

  describe.each(RESOLUTIONS)("resolution=%s", (resolution) => {
    it.each(malformed)("$label → 固定文で reject・RPC は 1 回・内容を載せない", async ({ data }) => {
      const { client, rpc } = fakeClient(async () => ({ data, error: null }));
      const e = await rejection(submitDuplicateResolution(client, duplicateInput({ resolution })));
      expect(e.message).toBe(UNKNOWN_RESULT);
      expect(e.name).toBe("Error");
      expect(e.cause).toBeUndefined();
      const leaked = everythingAbout(e);
      for (const secret of [SENTINEL, TXN, DUP_RESULT_ID, "ZodError", "Invalid"]) expect(leaked).not.toContain(secret);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith("resolve_suspected_duplicate", {
        p_bank_transaction_id: TXN,
        p_resolution: resolution,
        p_reason: null,
      });
    });

    it("正しい UUID → 従来どおり { ok: true }（uuid の値は返さない）", async () => {
      const { client, rpc } = fakeClient(async () => ({ data: DUP_RESULT_ID, error: null }));
      const result = await submitDuplicateResolution(client, duplicateInput({ resolution }));
      expect(result).toEqual({ ok: true });
      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it("既知の拒否は data が不正でも ok:false（error があれば data を見ない）", async () => {
      for (const refusal of DUPLICATE_REFUSALS) {
        for (const data of [null, "", "dup-1", 123, {}, DUP_RESULT_ID]) {
          const { client } = fakeClient(async () => ({ data, error: refusal }));
          expect(await submitDuplicateResolution(client, duplicateInput({ resolution }))).toEqual({ ok: false, error: refusal.message });
        }
      }
    });

    it("未知のエラーは data が何でも、秘密を含まない固定文の reject", async () => {
      for (const data of [null, DUP_RESULT_ID, `${SENTINEL}-data`]) {
        const { client, rpc } = fakeClient(async () => ({ data, error: { message: `internal ${SENTINEL}`, code: "XX000", details: SENTINEL } }));
        const e = await rejection(submitDuplicateResolution(client, duplicateInput({ resolution })));
        expect(e.message).toBe(UNKNOWN_RESULT);
        expect(everythingAbout(e)).not.toContain(SENTINEL);
        expect(rpc).toHaveBeenCalledTimes(1);
      }
    });
  });

  it("サーバーアクション resolveDuplicateAction: 不正な成功結果は reject し、再検証もしない", async () => {
    const { client, rpc } = fakeClient(async () => ({ data: "", error: null }));
    serverMocks.createUserClient.mockResolvedValue(client);
    serverMocks.revalidatePath.mockReset();
    const { resolveDuplicateAction } = await import("@/app/customers/[customerId]/actions");
    const e = await rejection(resolveDuplicateAction("00000000-0000-4000-8000-0000000000cc", duplicateInput()));
    expect(e.message).toBe(UNKNOWN_RESULT);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(serverMocks.revalidatePath).not.toHaveBeenCalled();
  });
});

// ---- 呼出し側（サーバーアクション）: 既存の catch が「結果不明」として扱える形で reject が届くこと ----
const serverMocks = vi.hoisted(() => ({
  createUserClient: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createUserClient: () => serverMocks.createUserClient() }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => serverMocks.revalidatePath(...a) }));

describe("サーバーアクション: 想定外のエラーは reject として届く（review-board / duplicates-panel の既存 catch が結果不明として扱う）", () => {
  const CUSTOMER = "00000000-0000-4000-8000-0000000000cc";
  const D1 = "00000000-0000-4000-8000-000000000001";
  const D2 = "00000000-0000-4000-8000-000000000002";
  const D3 = "00000000-0000-4000-8000-000000000003";

  beforeEach(() => {
    serverMocks.createUserClient.mockReset();
    serverMocks.revalidatePath.mockReset();
  });

  it("reviewAction: 想定外のエラーは秘密を含まない reject（業務上の拒否の戻り値にしない）", async () => {
    const { client } = returning({ message: `internal ${SENTINEL}`, code: "XX000", details: SENTINEL });
    serverMocks.createUserClient.mockResolvedValue(client);
    const { reviewAction } = await import("@/app/customers/[customerId]/actions");
    const e = await rejection(reviewAction(CUSTOMER, reviewInput()));
    expect(everythingAbout(e)).not.toContain(SENTINEL);
  });

  it("reviewAction: 既知の拒否は従来どおり ok:false を返す", async () => {
    const { client } = returning(REVIEW_REFUSALS[4]!);
    serverMocks.createUserClient.mockResolvedValue(client);
    const { reviewAction } = await import("@/app/customers/[customerId]/actions");
    expect(await reviewAction(CUSTOMER, reviewInput())).toEqual({ ok: false, error: REVIEW_REFUSALS[4]!.message });
  });

  it("resolveDuplicateAction: 想定外のエラーは秘密を含まない reject", async () => {
    const { client } = returning({ message: `<html>${SENTINEL}</html>`, code: "" });
    serverMocks.createUserClient.mockResolvedValue(client);
    const { resolveDuplicateAction } = await import("@/app/customers/[customerId]/actions");
    const e = await rejection(resolveDuplicateAction(CUSTOMER, duplicateInput()));
    expect(everythingAbout(e)).not.toContain(SENTINEL);
  });

  it("bulkApproveAction: 途中の想定外のエラーで reject し、以降の件を処理しない（一部確定済みの可能性を、failures に混ぜて隠さない）", async () => {
    let calls = 0;
    const { client, rpc } = fakeClient(async () => {
      calls += 1;
      if (calls === 1) return { data: "00000000-0000-4000-8000-0000000000dd", error: null }; // 1 件目は確定済み
      return { data: null, error: { message: `deadlock detected ${SENTINEL}`, code: "40P01", details: SENTINEL } };
    });
    serverMocks.createUserClient.mockResolvedValue(client);
    const { bulkApproveAction } = await import("@/app/customers/[customerId]/actions");
    const e = await rejection(
      bulkApproveAction(CUSTOMER, [
        { decisionId: D1, reviewSeconds: 1 },
        { decisionId: D2, reviewSeconds: 1 },
        { decisionId: D3, reviewSeconds: 1 },
      ]),
    );
    expect(everythingAbout(e)).not.toContain(SENTINEL);
    expect(rpc).toHaveBeenCalledTimes(2); // 3 件目は送らない
  });

  // 実際の submitReview を使う（モックしない）。不正な成功結果は結果不明の例外で止まり、以降の ID を送らない
  const POSITIONS = [
    { label: "1 件目", index: 0 },
    { label: "2 件目", index: 1 },
    { label: "3 件目", index: 2 },
  ] as const;
  const MALFORMED_SUCCESS = [
    { label: "空文字", data: "" },
    { label: "UUID でない文字列", data: `${SENTINEL}-not-a-uuid` },
    { label: "null", data: null },
  ] as const;

  describe.each(POSITIONS)("bulkApproveAction: $label で成功結果が不正", ({ index }) => {
    it.each(MALFORMED_SUCCESS)("$label → 固定文で reject し、以降の件を送らず、再試行もしない", async ({ data }) => {
      const ids = [D1, D2, D3];
      let calls = 0;
      const { client, rpc } = fakeClient(async () => {
        const position = calls;
        calls += 1;
        return { data: position === index ? data : `00000000-0000-4000-8000-0000000000e${position}`, error: null };
      });
      serverMocks.createUserClient.mockResolvedValue(client);
      const { bulkApproveAction } = await import("@/app/customers/[customerId]/actions");
      const e = await rejection(bulkApproveAction(CUSTOMER, ids.map((decisionId) => ({ decisionId, reviewSeconds: 1 }))));

      expect(e.message).toBe("確認の記録結果を取得できませんでした。記録済みの可能性があります");
      const leaked = everythingAbout(e);
      for (const secret of [SENTINEL, ...ids]) expect(leaked).not.toContain(secret);
      expect(rpc).toHaveBeenCalledTimes(index + 1);
      expect(rpc.mock.calls.map(([fn, args]) => [fn, args["p_ai_decision_id"]])).toEqual(
        ids.slice(0, index + 1).map((id) => ["record_human_review", id]),
      );
      for (const [, args] of rpc.mock.calls) expect(args).toMatchObject({ p_action: "approve", p_bulk: true, p_final_entry: null, p_reason: null });
      expect(serverMocks.revalidatePath).not.toHaveBeenCalled();
    });
  });

  it("bulkApproveAction: 既知の拒否は従来どおり failures に集めて続行する（業務上の拒否は不明ではない）", async () => {
    const refusal = REVIEW_REFUSALS[4]!;
    let calls = 0;
    const { client, rpc } = fakeClient(async () => {
      calls += 1;
      return calls === 2
        ? { data: null, error: refusal }
        : { data: `00000000-0000-4000-8000-00000000000${calls}`, error: null };
    });
    serverMocks.createUserClient.mockResolvedValue(client);
    const { bulkApproveAction } = await import("@/app/customers/[customerId]/actions");
    const result = await bulkApproveAction(CUSTOMER, [
      { decisionId: D1, reviewSeconds: 1 },
      { decisionId: D2, reviewSeconds: 1 },
      { decisionId: D3, reviewSeconds: 1 },
    ]);
    expect(result).toEqual({ approved: 2, failures: [{ decisionId: D2, error: refusal.message }] });
    expect(rpc).toHaveBeenCalledTimes(3);
  });
});
