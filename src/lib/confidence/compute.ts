import type { PastSearchResult } from "../retrieval/search";
import { normalizeText } from "../retrieval/normalize";
import type { BankTransaction, Customer, JournalEntryFields, MasterEntry, RuleVersion } from "../proposals/types";

export type ConfidenceLevel = "high" | "medium" | "low";

/** 「高」の条件（設計書7章の初期値）。ログを見ながら調整する */
export const HIGH_CONFIDENCE_MIN_PAST_COUNT = 5;
export const HIGH_CONFIDENCE_MIN_PAST_SHARE = 0.95;

/** 要注意語（設計書7章）。摘要に含まれていたら検査不合格 */
export const CAUTION_WORDS = [
  "返金", "ヘンキン", "立替", "タテカエ", "前払", "マエバライ", "個人", "コジン", "役員", "ヤクイン", "貸付", "カシツケ",
];

export type ConfidenceInput = {
  txn: BankTransaction;
  customer: Customer;
  masters: readonly MasterEntry[];
  rule: RuleVersion | null;
  past: PastSearchResult;
  /** その顧客の過去仕訳で使われた「科目:税区分」の組合せ（科目と税区分の整合の検査用） */
  knownCombos: ReadonlySet<string>;
  /** 最終的な提案（ルール一致ならルールの処理、なければ AI の案）。提案できなければ null */
  proposal: JournalEntryFields | null;
  ai:
    | { called: false }
    | {
        called: true;
        status: "ok" | "cannot_decide" | "not_in_master" | "refused" | "invalid" | "truncated";
        fixedAssetPossible: boolean;
        officerOrPersonal: boolean;
      };
};

export type ConfidenceCheck = { id: string; passed: boolean; detail: string };

export type ConfidenceBreakdown = {
  rule: { matched: boolean; ruleId: string | null; version: number | null };
  past: {
    matchType: PastSearchResult["matchType"];
    total: number;
    majority: { accountItemId: number; taxCode: number; count: number; share: number } | null;
    proposalAgreesWithMajority: boolean | null;
    amountWithinRange: boolean | null;
  };
  ai: { called: boolean; status: string | null; agreesWithRule: boolean | null; agreesWithPastMajority: boolean | null };
  checks: ConfidenceCheck[];
  /** 常に「低」に回す理由（上限額以上・固定資産・役員や個人） */
  forcedLow: string[];
  /** この確信度になった理由（人が読む用） */
  reasons: string[];
};

export type ConfidenceResult = { level: ConfidenceLevel; breakdown: ConfidenceBreakdown };

const sameCombo = (e: JournalEntryFields, c: { accountItemId: number; taxCode: number }) =>
  e.accountItemId === c.accountItemId && e.taxCode === c.taxCode;

/**
 * 確信度をプログラムで計算する（設計書7章）。AI の自己申告は使わない。
 * 証拠は「ルール一致・過去一致率・AIとの一致・検査」の4つ。
 */
export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const { txn, customer, masters, rule, past, proposal, ai } = input;
  const reasons: string[] = [];
  const forcedLow: string[] = [];

  // --- 常に「低」 ---
  if (txn.amount >= customer.lowConfidenceAmountThreshold) {
    forcedLow.push(`金額が顧客の上限額（${customer.lowConfidenceAmountThreshold}円）以上`);
  }
  const account = proposal ? masters.find((m) => m.kind === "account_item" && m.id === proposal.accountItemId) : undefined;
  if (account?.fixedAsset || (ai.called && ai.fixedAssetPossible)) {
    forcedLow.push("固定資産になり得る");
  }
  if (ai.called && ai.officerOrPersonal) {
    forcedLow.push("役員・個人が絡む可能性がある");
  }

  // --- 検査 ---
  const checks: ConfidenceCheck[] = [];
  const text = normalizeText(txn.description);
  const caution = CAUTION_WORDS.filter((w) => text.includes(w));
  checks.push({
    id: "caution_words",
    passed: caution.length === 0,
    detail: caution.length ? `要注意語: ${caution.join("、")}` : "要注意語なし",
  });
  if (proposal) {
    const consistent =
      account?.defaultTaxCode === proposal.taxCode || input.knownCombos.has(`${proposal.accountItemId}:${proposal.taxCode}`);
    checks.push({
      id: "account_tax_consistency",
      passed: consistent,
      detail: consistent ? "科目と税区分の組合せは既定または過去に使用あり" : "科目の既定税区分と違い、過去にも使われていない組合せ",
    });
  }

  // --- 過去一致率・AIとの一致 ---
  const majority = past.majority;
  const proposalAgreesWithMajority = proposal && majority ? sameCombo(proposal, majority) : null;
  const amountWithinRange = past.amountRange
    ? txn.amount >= past.amountRange.min && txn.amount <= past.amountRange.max
    : null;
  const ruleEntry = rule ? rule.action : null;
  const agreesWithRule = ai.called && ai.status === "ok" && proposal && ruleEntry ? sameCombo(proposal, ruleEntry) : null;

  const breakdown: ConfidenceBreakdown = {
    rule: { matched: rule !== null, ruleId: rule?.ruleId ?? null, version: rule?.version ?? null },
    past: { matchType: past.matchType, total: past.total, majority, proposalAgreesWithMajority, amountWithinRange },
    ai: {
      called: ai.called,
      status: ai.called ? ai.status : null,
      agreesWithRule,
      agreesWithPastMajority: ai.called && ai.status === "ok" ? proposalAgreesWithMajority : null,
    },
    checks,
    forcedLow,
    reasons,
  };

  // --- 判定 ---
  if (forcedLow.length > 0) {
    reasons.push(...forcedLow);
    return { level: "low", breakdown };
  }
  if (!proposal) {
    if (ai.called && ai.status === "cannot_decide") reasons.push("AI が判断できないと回答");
    else if (ai.called && ai.status === "not_in_master") reasons.push("AI の案にマスタにない値がある");
    else if (ai.called) reasons.push(`AI の回答を使えない（${ai.status}）`);
    else reasons.push("提案がない");
    return { level: "low", breakdown };
  }
  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    reasons.push(...failed.map((c) => `検査不合格: ${c.detail}`));
    return { level: "low", breakdown };
  }
  if (!rule && past.matchType === "none") {
    reasons.push("新規取引先（ルールも過去仕訳もない）");
    return { level: "low", breakdown };
  }
  if (!rule && proposalAgreesWithMajority === false) {
    reasons.push("AI の案が過去の多数派と違う");
    return { level: "low", breakdown };
  }

  // ルール一致は AI を呼ばずにルールの処理を提案する（設計書5章: AI の推測に頼らず確定的に処理）
  const strongEvidence =
    rule !== null ||
    (past.matchType === "exact" &&
      past.total >= HIGH_CONFIDENCE_MIN_PAST_COUNT &&
      (majority?.share ?? 0) >= HIGH_CONFIDENCE_MIN_PAST_SHARE &&
      proposalAgreesWithMajority === true);
  if (strongEvidence && amountWithinRange !== false) {
    reasons.push(rule ? "有効なルールに一致し、検査に合格" : "過去の同じ取引先で一致率が高く、AI の案も一致し、検査に合格");
    return { level: "high", breakdown };
  }

  if (amountWithinRange === false) reasons.push("金額が過去の範囲外");
  if (!rule && past.matchType === "similar") reasons.push("取引先キーが類似一致（完全一致ではない）");
  if (!rule && past.total < HIGH_CONFIDENCE_MIN_PAST_COUNT) reasons.push(`過去の件数が少ない（${past.total}件）`);
  if (!rule && majority && majority.share < HIGH_CONFIDENCE_MIN_PAST_SHARE) {
    reasons.push(`過去の一致率が ${Math.round(majority.share * 100)}%`);
  }
  return { level: "medium", breakdown };
}
