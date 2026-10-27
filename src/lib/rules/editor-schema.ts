import { z } from "zod";

/**
 * 既存ルールの編集画面（新しい版の保存）の入力検証。外部から来る値（画面・サーバーアクションの引数）は
 * すべて unknown として受け、ここで検証してから使う。純粋関数のみ（DB・通信はしない）。
 * DB の check 制約（journal_rule_versions）と同じ範囲を保つ。
 */

export const RULE_STATUSES = ["active", "proposed", "inactive"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];
export const RULE_STATUS_LABEL: Record<RuleStatus, string> = { active: "有効", proposed: "提案中", inactive: "無効" };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
/** 4桁の年（0001〜9999）。DB の date 列に入る範囲で、それより狭い独自の制限は設けない（保存済みの値を無効化できなくなるため） */
const DATE_MIN_YEAR = 1;
const DATE_MAX_YEAR = 9999;

const int32 = (label: string) =>
  z.number(`${label}は数値で指定してください`).int(`${label}は整数で指定してください`).min(INT32_MIN, `${label}が小さすぎます`).max(INT32_MAX, `${label}が大きすぎます`);

/** freee マスタの ID。bigint 列に入る安全な整数（1以上） */
const masterId = (label: string) =>
  z.number(`${label}を選んでください`).int(`${label}は整数で指定してください`).min(1, `${label}が正しくありません`).max(Number.MAX_SAFE_INTEGER, `${label}が大きすぎます`);

/** 前後の空白を除いても何も残らない（全角空白・改行を含む）か */
const isBlank = (v: string) => /^[\s　]*$/.test(v);

/**
 * 条件・雛形の文字列。空白だけなら null。空白以外を含むときは前後の空白も含めて入力のまま保つ
 * （取引先キーは完全一致で照合するので、整形して照合の意味を変えない）。
 */
const optionalText = (label: string) =>
  z
    .string(`${label}は文字列で指定してください`)
    .nullable()
    .transform((v) => (v === null || isBlank(v) ? null : v));

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** 実在する日付か（うるう年を含む）。YYYY-MM-DD の形式だけを受け付ける */
export function isRealIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < DATE_MIN_YEAR || year > DATE_MAX_YEAR || month < 1 || month > 12 || day < 1) return false;
  const days = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= days;
}

const dateField = (label: string) =>
  z
    .string(`${label}は日付で指定してください`)
    .refine(isRealIsoDate, `${label}は実在する日付（YYYY-MM-DD）で指定してください`)
    .nullable();

const condSchema = z
  .strictObject({
    partnerKey: optionalText("取引先キー"),
    descriptionKeyword: optionalText("摘要の語句"),
    amountMin: z
      .number("金額の下限は数値で指定してください")
      .int("金額の下限は整数（円）で指定してください")
      .min(0, "金額の下限は0以上にしてください")
      .max(Number.MAX_SAFE_INTEGER, "金額の下限が大きすぎます")
      .nullable(),
    amountMax: z
      .number("金額の上限は数値で指定してください")
      .int("金額の上限は整数（円）で指定してください")
      .min(1, "金額の上限は1以上にしてください")
      .max(Number.MAX_SAFE_INTEGER, "金額の上限が大きすぎます")
      .nullable(),
    walletId: z.string("口座の指定が正しくありません").regex(UUID, "口座の指定が正しくありません").nullable(),
    direction: z.enum(["income", "expense"], "入出金の向きが正しくありません").nullable(),
  })
  .refine(
    (c) =>
      c.partnerKey !== null ||
      c.descriptionKeyword !== null ||
      c.amountMin !== null ||
      c.amountMax !== null ||
      c.walletId !== null ||
      c.direction !== null,
    { message: "条件が1つもないルールは保存できません（全取引に一致してしまうため）。条件を1つ以上指定してください" },
  )
  .refine((c) => c.amountMin === null || c.amountMax === null || c.amountMin < c.amountMax, {
    message: "金額の下限（以上）は上限（未満）より小さくしてください",
  });

const actionSchema = z
  .strictObject({
    accountItemId: masterId("勘定科目"),
    taxCode: int32("税区分"),
    partnerId: masterId("取引先").nullable(),
    itemId: masterId("品目").nullable(),
    sectionId: masterId("部門").nullable(),
    tagIds: z.array(masterId("メモタグ"), "メモタグの指定が正しくありません"),
    descriptionTemplate: optionalText("摘要の雛形"),
  })
  .refine((a) => new Set(a.tagIds).size === a.tagIds.length, { message: "メモタグが重複しています" });

/**
 * 新しい版の保存の入力。customerId / ruleId / expectedVersion は「どの版を元に編集したか」を示す。
 * 作成者・作成元・版番号・顧客の上書きなど、ここにない項目は strict により拒否する（サーバーが決める）。
 */
export const ruleEditorSubmitSchema = z
  .strictObject({
    customerId: z.string("顧客の指定が正しくありません").regex(UUID, "顧客の指定が正しくありません"),
    ruleId: z.string("ルールの指定が正しくありません").regex(UUID, "ルールの指定が正しくありません"),
    expectedVersion: z
      .number("編集元の版が正しくありません")
      .int("編集元の版が正しくありません")
      .min(1, "編集元の版が正しくありません")
      // 保存する版（+1）が int32 に収まること
      .max(INT32_MAX - 1, "編集元の版が正しくありません"),
    status: z.enum(RULE_STATUSES, "状態が正しくありません"),
    priority: int32("優先順位"),
    cond: condSchema,
    action: actionSchema,
    validFrom: dateField("有効期間の開始日"),
    validTo: dateField("有効期間の終了日"),
  })
  .refine((v) => v.validFrom === null || v.validTo === null || v.validFrom <= v.validTo, {
    message: "有効期間の開始日は終了日以前にしてください",
  });

export type RuleEditorInput = z.output<typeof ruleEditorSubmitSchema>;

/** 検証エラーを利用者向けの文章にする（入力値そのものや内部の経路は含めない） */
export function formatEditorIssues(error: z.ZodError): string {
  const messages: string[] = [];
  for (const issue of error.issues) {
    const text = issue.code === "unrecognized_keys" ? "指定できない項目が含まれています" : issue.message;
    if (!messages.includes(text)) messages.push(text);
  }
  return messages.slice(0, 3).join(" / ") || "入力が不正です";
}
