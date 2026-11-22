import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/** 前後の空白（全角空白・改行を含む）を除く。DB の record_human_review と同じ扱い */
export const trimReason = (reason: string | null) => (reason ?? "").replace(/^[\s\u3000]+|[\s\u3000]+$/g, "");

// PostgreSQL の text／jsonb は U+0000 を保存できない。DB に送ると想定外の SQL エラー（結果不明）になるので、
// 送る前に固定文で断る。除去・置換はしない（入力の内容は文面に含めない）。
const noNul = (label: string) => ({
  check: (s: string) => !s.includes("\u0000"),
  params: { message: `${label}に NUL（U+0000）が含まれているため記録できません` },
});
const descriptionNul = noNul("摘要");
const reasonNul = noNul("理由");

export const reviewInputSchema = z
  .object({
    decisionId: z.string().uuid(),
    action: z.enum(["approve", "correct", "hold", "reject"]),
    finalEntry: z
      .object({
        account_item_id: z.number().int(),
        tax_code: z.number().int(),
        partner_id: z.number().int().nullable(),
        item_id: z.number().int().nullable(),
        section_id: z.number().int().nullable(),
        tag_ids: z.array(z.number().int()),
        description: z.string().max(250).refine(descriptionNul.check, descriptionNul.params),
      })
      .nullable(),
    reason: z.string().max(1000).refine(reasonNul.check, reasonNul.params).nullable(),
    reviewSeconds: z.number().int().min(0).max(86_400),
    bulk: z.boolean(),
  })
  .refine((v) => (v.action === "correct") === (v.finalEntry !== null), {
    message: "修正のときだけ確定内容を指定します",
  })
  .refine((v) => v.action !== "hold" || trimReason(v.reason) !== "", {
    message: "保留の理由を入力してください",
  });

export type ReviewInput = z.infer<typeof reviewInputSchema>;

// ---- DB エラーの境界 ----
// RPC が返した文面は、実在の「文面＋SQLSTATE」の組と完全に一致したときだけ画面へ渡す。
// それ以外（想定外の SQL エラー、通信失敗、HTML 応答など）は内部情報を含み得るうえ、記録されたかどうか
// 分からないので、ok:false にせず固定文の Error を投げる（画面側の catch が「結果不明」として扱う）。
// 組は supabase/migrations の 20261020000700_record_human_review.sql / 20261020000800_duplicate_reviews.sql /
// 20261105041046_reject_duplicate_hold.sql から拾った。
const NOT_STAFF = "ログインした担当者だけが確認を記録できます";

// bank_transactions.status の check 制約（20261020000300_past_entries_transactions.sql）の全値
const BANK_TRANSACTION_STATUSES = ["new", "proposed", "approved", "registered", "on_hold", "rejected", "duplicate_suspected", "duplicate"] as const;

const REVIEW_REFUSALS: ReadonlyMap<string, string> = new Map([
  [NOT_STAFF, "42501"],
  ["仕訳候補が見つかりません", "P0002"],
  ["保留の理由を入力してください", "P0001"],
  ["承認・修正・却下は承認者（管理者）だけが行えます。保留にして理由を残してください", "42501"],
  ["より新しい仕訳候補があります。画面を更新してください", "P0001"],
  ["この明細はすでに保留中です。管理者の確認を待ってください", "P0001"],
  ["まとめて承認できるのは確信度「高」だけです", "P0001"],
  ["保留中の明細はまとめて承認できません。1件ずつ確認してください", "P0001"],
  ["提案がないので承認できません。修正として入力してください", "P0001"],
  ["提案から変更がありません。承認してください", "P0001"],
  ["勘定科目と税区分は必須です", "P0001"],
  ...BANK_TRANSACTION_STATUSES.map((s) => [`この明細はすでに確認済みです（${s}）`, "P0001"] as const),
]);

const DUPLICATE_REFUSALS: ReadonlyMap<string, string> = new Map([
  [NOT_STAFF, "42501"],
  ["明細が見つかりません", "P0002"],
  ["重複として除外できるのは承認者（管理者）だけです", "42501"],
  ...BANK_TRANSACTION_STATUSES.map((s) => [`この明細は重複の確認待ちではありません（${s}）`, "P0001"] as const),
]);

// normalize_final_entry の「<種別> <整数> はマスタにありません」。値は返さず固定文にする
const MASTER_MISSING = /^(?:勘定科目|税区分|取引先|品目|部門|メモタグ) -?\d+ はマスタにありません$/;
const MASTER_MISSING_SAFE = "マスタにない値が指定されています。画面を更新してやり直してください";

/** 結果不明を表す固定文。元のエラーの内容・原因は載せない */
const UNKNOWN_RESULT_MESSAGE = "確認の記録結果を取得できませんでした。記録済みの可能性があります";
const unknownResultError = () => new Error(UNKNOWN_RESULT_MESSAGE);

/** 認識できる業務上の拒否なら画面に出してよい安全な文を返す。認識できなければ null */
function knownRefusal(table: ReadonlyMap<string, string>, error: unknown, allowMaster: boolean): string | null {
  if (typeof error !== "object" || error === null) return null;
  const { message, code } = error as { message?: unknown; code?: unknown };
  if (typeof message !== "string" || typeof code !== "string") return null;
  if (table.get(message) === code) return message;
  if (allowMaster && code === "P0001" && MASTER_MISSING.test(message)) return MASTER_MISSING_SAFE;
  return null;
}

/** RPC を呼ぶ。送信側の例外（通信失敗など）は内容を捨てて固定文の Error にする */
async function callRpc(client: SupabaseClient, fn: string, args: Record<string, unknown>) {
  try {
    return await client.rpc(fn, args);
  } catch {
    throw unknownResultError();
  }
}

/**
 * 人の確認を記録する（record_human_review）。ログインした担当者の権限で呼ぶので、確認者は DB 側で
 * auth.uid() に固定され、他人の名前では記録できない。外部（freee）への書込はここではしない。
 */
export async function submitReview(client: SupabaseClient, input: ReviewInput): Promise<{ ok: true; reviewId: string } | { ok: false; error: string }> {
  const parsed = reviewInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "入力が不正です" };
  const v = parsed.data;
  const { data, error } = await callRpc(client, "record_human_review", {
    p_ai_decision_id: v.decisionId,
    p_action: v.action,
    p_final_entry: v.finalEntry,
    p_reason: v.reason,
    p_review_seconds: v.reviewSeconds,
    p_bulk: v.bulk,
  });
  if (error) {
    const refusal = knownRefusal(REVIEW_REFUSALS, error, true);
    if (refusal === null) throw unknownResultError();
    return { ok: false, error: refusal };
  }
  // record_human_review は uuid を返す。形が違う成功結果は記録できたか判断できないので、内容を載せず結果不明にする
  const reviewId = z.string().uuid().safeParse(data);
  if (!reviewId.success) throw unknownResultError();
  return { ok: true, reviewId: reviewId.data };
}

export const duplicateResolutionSchema = z.object({
  bankTransactionId: z.string().uuid(),
  resolution: z.enum(["distinct", "duplicate"]),
  reason: z.string().max(1000).refine(reasonNul.check, reasonNul.params).nullable(),
});
export type DuplicateResolutionInput = z.infer<typeof duplicateResolutionSchema>;

/**
 * 重複の疑いがある明細を「別の取引」か「重複」に決める（resolve_suspected_duplicate）。
 * 「重複」として除外できるのは承認者（管理者）だけで、DB 側で確かめる。
 */
export async function submitDuplicateResolution(
  client: SupabaseClient,
  input: DuplicateResolutionInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = duplicateResolutionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "入力が不正です" };
  const { data, error } = await callRpc(client, "resolve_suspected_duplicate", {
    p_bank_transaction_id: parsed.data.bankTransactionId,
    p_resolution: parsed.data.resolution,
    p_reason: parsed.data.reason,
  });
  if (error) {
    const refusal = knownRefusal(DUPLICATE_REFUSALS, error, false);
    if (refusal === null) throw unknownResultError();
    return { ok: false, error: refusal };
  }
  // resolve_suspected_duplicate は uuid を返す。形が違う成功結果は記録できたか判断できないので結果不明にする（uuid は返さない）
  if (!z.string().uuid().safeParse(data).success) throw unknownResultError();
  return { ok: true };
}
