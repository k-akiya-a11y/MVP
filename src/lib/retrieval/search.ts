import type { BankTransaction, PastEntry } from "../proposals/types";
import { partnerKey as toPartnerKey, similarity } from "./normalize";

/** 類似キーとみなす下限（bigram の Dice 係数） */
export const SIMILAR_KEY_THRESHOLD = 0.8;
/** AI に渡す代表例の件数 */
export const EXAMPLE_COUNT = 5;

export type ComboCount = { accountItemId: number; taxCode: number; count: number };

export type PastSearchResult = {
  partnerKey: string | null;
  /** exact: 取引先キーが一致 / similar: 類似キー / none: 新規取引先 */
  matchType: "exact" | "similar" | "none";
  matchedKeys: string[];
  total: number;
  /** 科目×税区分ごとの件数（多い順） */
  combos: ComboCount[];
  /** 最多の組合せとその割合 */
  majority: (ComboCount & { share: number }) | null;
  amountRange: { min: number; max: number } | null;
  /** 金額が近い順の代表例 */
  examples: PastEntry[];
};

/**
 * 過去仕訳の検索（設計書6章）。取引先キーの完全一致 → なければ類似キー → なければ新規取引先。
 * 入出金の向きが同じものだけを対象にする。顧客あたり数百〜数千件なのでメモリ上で計算する。
 */
export function searchPastEntries(txn: BankTransaction, past: readonly PastEntry[]): PastSearchResult {
  const key = toPartnerKey(txn.description);
  const sameDirection = past.filter((p) => p.direction === txn.direction && p.partnerKey);
  let matched: PastEntry[] = [];
  let matchType: PastSearchResult["matchType"] = "none";
  let matchedKeys: string[] = [];

  if (key) {
    matched = sameDirection.filter((p) => p.partnerKey === key);
    if (matched.length > 0) {
      matchType = "exact";
      matchedKeys = [key];
    } else {
      const scores = new Map<string, number>();
      for (const p of sameDirection) {
        const k = p.partnerKey!;
        if (!scores.has(k)) scores.set(k, similarity(key, k));
      }
      const best = Math.max(0, ...scores.values());
      if (best >= SIMILAR_KEY_THRESHOLD) {
        matchedKeys = [...scores].filter(([, s]) => s === best).map(([k]) => k);
        matched = sameDirection.filter((p) => matchedKeys.includes(p.partnerKey!));
        matchType = "similar";
      }
    }
  }

  const comboMap = new Map<string, ComboCount>();
  for (const p of matched) {
    const id = `${p.entry.accountItemId}:${p.entry.taxCode}`;
    const c = comboMap.get(id) ?? { accountItemId: p.entry.accountItemId, taxCode: p.entry.taxCode, count: 0 };
    c.count++;
    comboMap.set(id, c);
  }
  const combos = [...comboMap.values()].sort((a, b) => b.count - a.count || a.accountItemId - b.accountItemId);
  const top = combos[0];
  const amounts = matched.map((p) => p.amount);

  const examples = [...matched]
    .sort(
      (a, b) =>
        Math.abs(a.amount - txn.amount) - Math.abs(b.amount - txn.amount) ||
        b.entryDate.localeCompare(a.entryDate),
    )
    .slice(0, EXAMPLE_COUNT);

  return {
    partnerKey: key,
    matchType,
    matchedKeys,
    total: matched.length,
    combos,
    majority: top ? { ...top, share: top.count / matched.length } : null,
    amountRange: amounts.length > 0 ? { min: Math.min(...amounts), max: Math.max(...amounts) } : null,
    examples,
  };
}
