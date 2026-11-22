/** 過去仕訳の科目の揺れの集計（設計書14章「初期取込時に科目の揺れが大きい取引先を一覧にして担当者が確認」）。 */

export type PastQualityRow = {
  id: string;
  /** YYYY-MM-DD */
  entryDate: string;
  direction: "income" | "expense";
  /** 取込時に保存された取引先キー。再正規化せず、保存された値をそのまま使う */
  partnerKey: string | null;
  accountItemId: number;
};

export type DateRange = { from: string; to: string };

export type AccountCount = {
  accountItemId: number;
  count: number;
  dateRange: DateRange;
  /** 根拠の過去仕訳ID（日付・ID順） */
  entryIds: string[];
};

export type VariantGroup = {
  direction: "income" | "expense";
  partnerKey: string;
  total: number;
  dateRange: DateRange;
  /** 科目ごとの件数（多い順、同数は科目ID順） */
  accounts: AccountCount[];
};

/**
 * 初期ルールの検討候補（設計書「過去仕訳から取引先ごとに科目が固定しているものを抽出」）。
 * 人が確認するための事実の要約で、ルール（RuleVersion）ではない。税区分・補助科目・金額条件・有効期間などは推測せず持たない。
 */
export type StableAccountCandidate = {
  kind: "rule-consideration-candidate";
  direction: "income" | "expense";
  partnerKey: string;
  accountItemId: number;
  /** 根拠の件数。足切りも確度の推定もしない（1件のみのものも含む） */
  count: number;
  dateRange: DateRange;
  /** 根拠の過去仕訳ID（日付・ID順） */
  entryIds: string[];
};

export type PastQualityReport = {
  totalEntries: number;
  /** 読み込んだ過去仕訳の日付範囲。freee の全期間や直近24か月を保証するものではない */
  importedRange: DateRange | null;
  /** 取引先キーがある仕訳の数 */
  keyedEntries: number;
  /** 取引先キーごと・入出金の向きごとのグループ数（科目が1種類のものも含む） */
  groupCount: number;
  /** 科目が2種類以上あるグループ。件数による足切りはしない */
  variantGroups: VariantGroup[];
  /** 科目がちょうど1種類のグループ（ルール検討用）。多い順、同数は向き・キー順。variantGroups とは重ならない */
  stableAccountCandidates: StableAccountCandidate[];
  /** 取引先キーが null または空白だけの仕訳。取引先としてはまとめない */
  missingKey: { count: number; dateRange: DateRange | null; entryIds: string[] };
};

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byDateThenId = (a: PastQualityRow, b: PastQualityRow) => compareText(a.entryDate, b.entryDate) || compareText(a.id, b.id);

function rangeOf(rows: readonly PastQualityRow[]): DateRange {
  const first = rows[0];
  // 呼び出し側は空でないときだけ呼ぶ。崩れたら空の範囲を作らず例外にする
  if (!first) throw new Error("日付範囲を求める対象の過去仕訳がありません");
  let from = first.entryDate;
  let to = first.entryDate;
  for (const r of rows) {
    if (r.entryDate < from) from = r.entryDate;
    if (r.entryDate > to) to = r.entryDate;
  }
  return { from, to };
}

/**
 * 取引先キー（保存値の完全一致）と入出金の向きごとに、科目が複数あるグループを集める。
 * 入力は変更しない。同じ過去仕訳IDが2回あると根拠を黙って落とすことになるので例外にする。
 */
export function aggregatePastQuality(rows: readonly PastQualityRow[]): PastQualityReport {
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id)) throw new Error(`過去仕訳のIDが重複しています: ${r.id}`);
    seen.add(r.id);
  }

  const sorted = [...rows].sort(byDateThenId);
  const missing: PastQualityRow[] = [];
  const groups = new Map<string, { direction: PastQualityRow["direction"]; partnerKey: string; rows: PastQualityRow[] }>();
  for (const r of sorted) {
    if (r.partnerKey === null || r.partnerKey.trim() === "") {
      missing.push(r);
      continue;
    }
    const id = JSON.stringify([r.direction, r.partnerKey]);
    const g = groups.get(id) ?? { direction: r.direction, partnerKey: r.partnerKey, rows: [] };
    g.rows.push(r);
    groups.set(id, g);
  }

  const variantGroups: VariantGroup[] = [];
  const stableAccountCandidates: StableAccountCandidate[] = [];
  for (const g of groups.values()) {
    const byAccount = new Map<number, PastQualityRow[]>();
    for (const r of g.rows) {
      // この関数が作った配列にだけ追加する（入力の配列は変更しない）
      const list = byAccount.get(r.accountItemId);
      if (list) list.push(r);
      else byAccount.set(r.accountItemId, [r]);
    }
    if (byAccount.size === 1) {
      const [accountItemId] = [...byAccount.keys()];
      if (accountItemId === undefined) throw new Error("科目の集計が崩れています");
      stableAccountCandidates.push({
        kind: "rule-consideration-candidate",
        direction: g.direction,
        partnerKey: g.partnerKey,
        accountItemId,
        count: g.rows.length,
        dateRange: rangeOf(g.rows),
        entryIds: g.rows.map((r) => r.id),
      });
      continue;
    }
    variantGroups.push({
      direction: g.direction,
      partnerKey: g.partnerKey,
      total: g.rows.length,
      dateRange: rangeOf(g.rows),
      accounts: [...byAccount]
        .map(([accountItemId, list]) => ({
          accountItemId,
          count: list.length,
          dateRange: rangeOf(list),
          entryIds: list.map((r) => r.id),
        }))
        .sort((a, b) => b.count - a.count || a.accountItemId - b.accountItemId),
    });
  }
  variantGroups.sort(
    (a, b) =>
      b.accounts.length - a.accounts.length ||
      b.total - a.total ||
      compareText(a.direction, b.direction) ||
      compareText(a.partnerKey, b.partnerKey),
  );

  stableAccountCandidates.sort(
    (a, b) => b.count - a.count || compareText(a.direction, b.direction) || compareText(a.partnerKey, b.partnerKey),
  );

  return {
    totalEntries: rows.length,
    importedRange: sorted.length > 0 ? rangeOf(sorted) : null,
    keyedEntries: rows.length - missing.length,
    groupCount: groups.size,
    variantGroups,
    stableAccountCandidates,
    missingKey: {
      count: missing.length,
      dateRange: missing.length > 0 ? rangeOf(missing) : null,
      entryIds: missing.map((r) => r.id),
    },
  };
}
