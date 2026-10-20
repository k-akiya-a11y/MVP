import type { BankTransaction, RuleVersion } from "../proposals/types";
import { normalizeText, partnerKey as toPartnerKey } from "../retrieval/normalize";

/**
 * 構造化ルールの照合（設計書5章）。渡すのは各ルールの現在の版で、状態が「有効」のものだけ。
 * 指定された条件をすべて満たすルールのうち、優先順位（小さいほど優先）→ 作成日時の順で最初のものを返す。
 */
export function matchRule(txn: BankTransaction, activeRules: readonly RuleVersion[]): RuleVersion | null {
  const key = toPartnerKey(txn.description);
  const text = normalizeText(txn.description);
  const candidates = activeRules.filter((r) => {
    const c = r.cond;
    if (r.validFrom && txn.txnDate < r.validFrom) return false;
    if (r.validTo && txn.txnDate > r.validTo) return false;
    if (c.partnerKey !== null && c.partnerKey !== key) return false;
    if (c.descriptionKeyword !== null && !text.includes(normalizeText(c.descriptionKeyword))) return false;
    if (c.amountMin !== null && txn.amount < c.amountMin) return false;
    if (c.amountMax !== null && txn.amount >= c.amountMax) return false;
    if (c.walletId !== null && c.walletId !== txn.walletId) return false;
    if (c.direction !== null && c.direction !== txn.direction) return false;
    return true;
  });
  candidates.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  return candidates[0] ?? null;
}

/** 摘要の雛形を埋める。使える差込み: {month}（取引月）、{year}、{description}（明細の摘要） */
export function renderDescriptionTemplate(template: string, txn: BankTransaction): string {
  const [year, month] = txn.txnDate.split("-");
  return template
    .replaceAll("{year}", year ?? "")
    .replaceAll("{month}", String(Number(month)))
    .replaceAll("{description}", txn.description);
}
