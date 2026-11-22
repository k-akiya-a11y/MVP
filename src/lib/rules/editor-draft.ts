import type { EditorRule } from "./editor-load";
import type { RuleStatus } from "./editor-schema";

/** 編集中の値。画面の入力欄に合わせてすべて文字列（null は空文字）。保存されている現在の版から始める */
export type RuleDraft = {
  priority: string;
  partnerKey: string;
  descriptionKeyword: string;
  amountMin: string;
  amountMax: string;
  walletId: string;
  direction: string;
  accountItemId: string;
  taxCode: string;
  partnerId: string;
  itemId: string;
  sectionId: string;
  tagIds: string[];
  descriptionTemplate: string;
  validFrom: string;
  validTo: string;
};

const text = (v: string | number | null) => (v === null ? "" : String(v));

export function toDraft(rule: EditorRule): RuleDraft {
  return {
    priority: text(rule.priority),
    partnerKey: text(rule.cond.partnerKey),
    descriptionKeyword: text(rule.cond.descriptionKeyword),
    amountMin: text(rule.cond.amountMin),
    amountMax: text(rule.cond.amountMax),
    walletId: text(rule.cond.walletId),
    direction: text(rule.cond.direction),
    accountItemId: text(rule.action.accountItemId),
    taxCode: text(rule.action.taxCode),
    partnerId: text(rule.action.partnerId),
    itemId: text(rule.action.itemId),
    sectionId: text(rule.action.sectionId),
    tagIds: rule.action.tagIds.map(String),
    descriptionTemplate: text(rule.action.descriptionTemplate),
    validFrom: text(rule.validFrom),
    validTo: text(rule.validTo),
  };
}

/** 空欄は null。数字だけの文字列は数値に、それ以外は文字列のまま返して検証側で弾く（NaN や 0 に化けさせない） */
function numberOrRaw(value: string): number | string | null {
  const v = value.trim();
  if (v === "") return null;
  return /^-?\d+$/.test(v) ? Number(v) : v;
}

/** 空欄は null、それ以外は入力のまま（取引先キーなど、前後の空白も含めて照合に影響するため整形しない） */
const textOrNull = (value: string): string | null => (value === "" ? null : value);

/**
 * 画面の値を、保存の入力（ruleEditorSubmitSchema が検証する unknown）にする。
 * 作成者・作成元・版番号などは含めない。値の検証はサーバー側のスキーマが行う。
 */
export function draftToInput(args: { customerId: string; ruleId: string; expectedVersion: number; status: RuleStatus; draft: RuleDraft }): unknown {
  const d = args.draft;
  return {
    customerId: args.customerId,
    ruleId: args.ruleId,
    expectedVersion: args.expectedVersion,
    status: args.status,
    priority: numberOrRaw(d.priority),
    cond: {
      partnerKey: textOrNull(d.partnerKey),
      descriptionKeyword: textOrNull(d.descriptionKeyword),
      amountMin: numberOrRaw(d.amountMin),
      amountMax: numberOrRaw(d.amountMax),
      walletId: textOrNull(d.walletId),
      direction: textOrNull(d.direction),
    },
    action: {
      accountItemId: numberOrRaw(d.accountItemId),
      taxCode: numberOrRaw(d.taxCode),
      partnerId: numberOrRaw(d.partnerId),
      itemId: numberOrRaw(d.itemId),
      sectionId: numberOrRaw(d.sectionId),
      tagIds: d.tagIds.map((t) => numberOrRaw(t)),
      descriptionTemplate: textOrNull(d.descriptionTemplate),
    },
    validFrom: textOrNull(d.validFrom),
    validTo: textOrNull(d.validTo),
  };
}
