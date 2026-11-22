import { z } from "zod";
import { UUID } from "./editor-schema";

/**
 * 過去仕訳の候補から新しいルール（提案中）を作る画面の入力検証。URL・フォーム・サーバーアクションの値は
 * すべて信用せず（unknown として受け）、ここで検証してから使う。純粋関数のみ（DB・通信はしない）。
 */

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

/** 前後の空白を除いても何も残らない（全角空白・改行を含む）か */
const isBlank = (v: string) => /^[\s　]*$/.test(v);

/** 取引先キー。完全一致で照合するので、空白だけは拒否し、それ以外は前後の空白も含めて入力のまま保つ */
const partnerKey = z
  .string("取引先キーが正しくありません")
  .refine((v) => !isBlank(v), "取引先キーが空です");
const direction = z.enum(["income", "expense"], "入出金の向きが正しくありません");
const customerId = z.string("顧客の指定が正しくありません").regex(UUID, "顧客の指定が正しくありません");
const requestId = z.string("依頼IDが正しくありません").regex(UUID, "依頼IDが正しくありません");

/** 勘定科目ID。bigint 列に入る安全な整数（1以上） */
const accountItemId = z
  .number("勘定科目が正しくありません")
  .int("勘定科目が正しくありません")
  .min(1, "勘定科目が正しくありません")
  .max(Number.MAX_SAFE_INTEGER, "勘定科目が正しくありません");

const int32 = (label: string) =>
  z
    .number(`${label}を入力してください`)
    .int(`${label}は整数で指定してください`)
    .min(INT32_MIN, `${label}が小さすぎます`)
    .max(INT32_MAX, `${label}が大きすぎます`);

/** 新規ルール画面を開くときの URL の検索パラメータ（文字列）。すべて外部入力 */
export const candidateQuerySchema = z.strictObject({
  key: partnerKey,
  direction,
  accountId: z
    .string("勘定科目が正しくありません")
    .regex(/^[1-9][0-9]*$/, "勘定科目が正しくありません")
    .transform(Number)
    .pipe(accountItemId),
  requestId,
});
export type CandidateQuery = z.output<typeof candidateQuerySchema>;

/**
 * 保存の入力。作成者・状態・作成元・版・有効フラグ・その他の条件や処理の項目は、ここにないので strict により拒否する
 * （サーバーと DB 関数が決める）。税区分と優先順位は人が明示的に決めた値だけで、既定値を持たない。
 */
export const createRuleFromCandidateSchema = z.strictObject({
  customerId,
  requestId,
  partnerKey,
  direction,
  accountItemId,
  taxCode: int32("税区分"),
  priority: int32("優先順位"),
});
export type CreateRuleFromCandidateInput = z.output<typeof createRuleFromCandidateSchema>;

/**
 * 画面の検索パラメータを検証する。同じキーが複数ある（配列）・未知のキー・欠落は拒否する。
 * 失敗の中身は呼び出し側へ返さない（画面には固定文を出す）。
 */
export function parseCandidateQuery(raw: unknown): CandidateQuery | null {
  const parsed = candidateQuerySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 新規ルール画面へのリンク。すべての値を URLSearchParams でエンコードする。依頼IDは呼出側が1リンクごとに決める */
export function newRuleHref(
  customerIdValue: string,
  candidate: { partnerKey: string; direction: "income" | "expense"; accountItemId: number },
  requestIdValue: string,
): string {
  const params = new URLSearchParams();
  params.set("key", candidate.partnerKey);
  params.set("direction", candidate.direction);
  params.set("accountId", String(candidate.accountItemId));
  params.set("requestId", requestIdValue);
  return `/customers/${encodeURIComponent(customerIdValue)}/rules/new?${params.toString()}`;
}

/** 結果が不明なときの固定文（画面とサーバーで共通。クライアントに読込・DB の処理を持ち込まないためここに置く） */
export const CREATE_UNKNOWN_MESSAGE =
  "保存できたかどうかを確認できませんでした。保存されていない、とは言い切れません。自動では再送しません。顧客ルールの一覧で、この依頼IDのルールがあるか確認してください。";

export type CandidateDraft ={ taxCode: string; priority: string };

/** 画面の入力欄（文字列）の整数。空欄は null（0 にしない）。整数の書式でなければ undefined */
function parseIntegerText(value: string): number | null | undefined {
  const text = value.trim();
  if (text === "") return null;
  if (!/^-?[0-9]+$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * 画面の入力欄から保存の入力を作る。税区分・優先順位が空欄なら作れない（既定値を入れない）。
 * 値の範囲は createRuleFromCandidateSchema が検証する（ここでは書式だけを見る）。
 */
export function draftToCreateInput(
  base: { customerId: string; requestId: string; partnerKey: string; direction: "income" | "expense"; accountItemId: number },
  draft: CandidateDraft,
): { ok: true; input: unknown } | { ok: false; message: string } {
  const tax = parseIntegerText(draft.taxCode);
  if (tax === null) return { ok: false, message: "税区分を選んでください。" };
  if (tax === undefined) return { ok: false, message: "税区分が正しくありません。" };
  const priority = parseIntegerText(draft.priority);
  if (priority === null) return { ok: false, message: "優先順位を入力してください（小さいほど優先されます）。" };
  if (priority === undefined) return { ok: false, message: "優先順位は整数で入力してください。" };
  return { ok: true, input: { ...base, taxCode: tax, priority } };
}
