import { z } from "zod";
import type { ImportCounts } from "./import";

/**
 * 明細 CSV アップロード（クライアント側）の送信と結果の判定。
 * 応答を型断定せず zod で検証し、「登録されていないと言い切れる場合」と「結果が分からない場合」を分ける。
 * 送信は1回だけで、失敗しても自動では再送しない。
 */
export type UploadOutcome =
  /** 取込に成功した（件数・金額の要約つき） */
  | { kind: "success"; message: string }
  /** 取込を拒否したと確認できた（明細は登録されていない） */
  | { kind: "rejected"; message: string }
  /** 応答が得られない・読めない・想定外。登録済みかもしれない */
  | { kind: "unknown"; message: string };

const count = z.number().int().nonnegative();

const successSchema = z.object({
  ok: z.literal(true),
  importId: z.string().uuid(),
  insertedCount: count,
  skippedDuplicateCount: count,
  suspectedDuplicateCount: count,
  ignoredCount: count,
  incomeTotal: count,
  expenseTotal: count,
  insertedAmountTotal: count,
  skippedAmountTotal: count,
  suspectedAmountTotal: count,
});

const validationFailureSchema = z.object({
  ok: z.literal(false),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })).nonempty(),
  failureRecordId: z.string().uuid().nullable(),
});

const errorSchema = z.object({ error: z.string().min(1) });

/** 結果が分からないときの表示。取込が済んでいる場合があるので、再送の前に確認してもらう */
export const UPLOAD_UNKNOWN_MESSAGE =
  "取込の結果を確認できませんでした。明細はすでに登録されている可能性があります。画面を再読み込みして、取引の一覧と取込の記録を確認してから、必要な場合だけもう一度取り込んでください。";

const unknown = (): UploadOutcome => ({ kind: "unknown", message: UPLOAD_UNKNOWN_MESSAGE });

/** ルート（statements/route.ts）が登録より前に返す状態と、その意味に合わせた固定の表示 */
const PRE_REGISTRATION_MESSAGES: Record<number, string> = {
  400: "取り込めませんでした（明細は1件も登録していません）: 顧客・ファイル・口座・形式の指定を確認してください",
  401: "取り込めませんでした（明細は1件も登録していません）: ログインしてください",
  404: "取り込めませんでした（明細は1件も登録していません）: 口座が見つかりません",
  413: "取り込めませんでした（明細は1件も登録していません）: ファイルが大きすぎます（5MB まで）",
};

export async function submitStatementUpload(
  fetchFn: typeof fetch,
  url: string,
  body: FormData,
): Promise<UploadOutcome> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: "POST", body });
  } catch {
    return unknown();
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return unknown();
  }

  if (res.status >= 200 && res.status < 300) {
    const parsed = successSchema.safeParse(json);
    return parsed.success ? { kind: "success", message: importSummary(parsed.data) } : unknown();
  }

  if (res.status === 422) {
    const parsed = validationFailureSchema.safeParse(json);
    if (!parsed.success) return unknown();
    return {
      kind: "rejected",
      message:
        `取り込めませんでした（明細は1件も登録していません${parsed.data.failureRecordId ? "。失敗として記録しました" : ""}）: ` +
        parsed.data.errors
          .slice(0, 5)
          .map((e) => `${e.line}行目 ${e.message}`)
          .join(" / "),
    };
  }

  // ルートが登録の前に返す状態だけを「登録されていない」と扱い、表示は本文ではなく固定の文言にする。
  // それ以外（408・429・プロキシの 4xx・5xx など）は登録済みかもしれないので結果不明のまま
  const known = PRE_REGISTRATION_MESSAGES[res.status];
  if (known && errorSchema.safeParse(json).success) return { kind: "rejected", message: known };
  return unknown();
}

const yen = (n: number) => n.toLocaleString("ja-JP");

/** 取込結果の件数と金額。読めた行 = 登録 + 読み飛ばし + 重複の疑い で照合できるように並べる */
export function importSummary(c: ImportCounts): string {
  const lines = [
    `読めた行 ${c.insertedCount + c.skippedDuplicateCount + c.suspectedDuplicateCount}件（入金 ${yen(c.incomeTotal)}円・出金 ${yen(c.expenseTotal)}円）`,
    `登録 ${c.insertedCount}件 ${yen(c.insertedAmountTotal)}円`,
    `取込済みのため読み飛ばし ${c.skippedDuplicateCount}件 ${yen(c.skippedAmountTotal)}円`,
  ];
  if (c.suspectedDuplicateCount) {
    lines.push(`重複の疑い ${c.suspectedDuplicateCount}件 ${yen(c.suspectedAmountTotal)}円（「重複の疑い」で確認してください）`);
  }
  if (c.ignoredCount) lines.push(`金額0のため取引にしなかった行 ${c.ignoredCount}件`);
  return lines.join(" ／ ");
}
