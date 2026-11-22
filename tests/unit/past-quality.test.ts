import { describe, expect, it } from "vitest";
import { aggregatePastQuality, type PastQualityRow } from "@/lib/retrieval/past-quality";

let seq = 0;
const row = (o: Partial<PastQualityRow> & Pick<PastQualityRow, "accountItemId">): PastQualityRow => ({
  id: `e${String(++seq).padStart(3, "0")}`,
  entryDate: "2026-01-10",
  direction: "expense",
  partnerKey: "ACME",
  ...o,
});

describe("aggregatePastQuality", () => {
  it("同じキー・向きで科目が分かれたグループを件数・期間・根拠IDつきで返す", () => {
    const rows = [
      row({ id: "a", accountItemId: 100, entryDate: "2026-03-01" }),
      row({ id: "b", accountItemId: 100, entryDate: "2026-01-05" }),
      row({ id: "c", accountItemId: 200, entryDate: "2026-02-01" }),
    ];
    const r = aggregatePastQuality(rows);
    expect(r.variantGroups).toHaveLength(1);
    const g = r.variantGroups[0];
    if (!g) throw new Error("variantGroups[0] がありません");
    expect(g.total).toBe(3);
    expect(g.dateRange).toEqual({ from: "2026-01-05", to: "2026-03-01" });
    expect(g.accounts).toEqual([
      { accountItemId: 100, count: 2, dateRange: { from: "2026-01-05", to: "2026-03-01" }, entryIds: ["b", "a"] },
      { accountItemId: 200, count: 1, dateRange: { from: "2026-02-01", to: "2026-02-01" }, entryIds: ["c"] },
    ]);
    expect(r.importedRange).toEqual({ from: "2026-01-05", to: "2026-03-01" });
  });

  it("向きが違うもの、キーが似ているだけのものは別グループで、揺れとして出さない", () => {
    const r = aggregatePastQuality([
      row({ accountItemId: 100, direction: "expense" }),
      row({ accountItemId: 200, direction: "income" }),
      row({ accountItemId: 300, partnerKey: "ACME " }),
      row({ accountItemId: 400, partnerKey: "acme" }),
    ]);
    expect(r.groupCount).toBe(4);
    expect(r.variantGroups).toEqual([]);
  });

  it("キーが null・空・空白だけの仕訳は別に数え、取引先としてまとめない", () => {
    const r = aggregatePastQuality([
      row({ id: "n1", accountItemId: 100, partnerKey: null }),
      row({ id: "n2", accountItemId: 200, partnerKey: "" }),
      row({ id: "n3", accountItemId: 300, partnerKey: "  " }),
      row({ accountItemId: 100 }),
    ]);
    expect(r.missingKey.count).toBe(3);
    expect(r.missingKey.entryIds).toEqual(["n1", "n2", "n3"]);
    expect(r.keyedEntries).toBe(1);
    expect(r.groupCount).toBe(1);
    expect(r.variantGroups).toEqual([]);
  });

  it("履歴なし・揺れなしを区別できる", () => {
    const none = aggregatePastQuality([]);
    expect(none).toMatchObject({ totalEntries: 0, importedRange: null, groupCount: 0, variantGroups: [] });
    expect(none.missingKey).toEqual({ count: 0, dateRange: null, entryIds: [] });
    const same = aggregatePastQuality([row({ accountItemId: 100 }), row({ accountItemId: 100 })]);
    expect(same.totalEntries).toBe(2);
    expect(same.variantGroups).toEqual([]);
  });

  it("件数が少ない揺れも足切りせず出し、入力順に依らず同じ並びになる", () => {
    const rows = [
      row({ partnerKey: "B", accountItemId: 1 }),
      row({ partnerKey: "B", accountItemId: 2 }),
      row({ partnerKey: "A", accountItemId: 1 }),
      row({ partnerKey: "A", accountItemId: 2 }),
      row({ partnerKey: "C", accountItemId: 1 }),
      row({ partnerKey: "C", accountItemId: 2 }),
      row({ partnerKey: "C", accountItemId: 3 }),
    ];
    const a = aggregatePastQuality(rows);
    const b = aggregatePastQuality([...rows].reverse());
    expect(b).toEqual(a);
    expect(a.variantGroups.map((g) => g.partnerKey)).toEqual(["C", "A", "B"]);
  });

  it("入力を変更しない", () => {
    const rows = [row({ accountItemId: 2, entryDate: "2026-02-01" }), row({ accountItemId: 1, entryDate: "2026-01-01" })];
    const copy = structuredClone(rows);
    aggregatePastQuality(rows);
    expect(rows).toEqual(copy);
  });

  it("すべての過去仕訳IDが揺れ・固定候補・欠落キーのどれか1つに残る", () => {
    const rows = [
      row({ accountItemId: 1 }),
      row({ accountItemId: 2 }),
      row({ accountItemId: 2 }),
      row({ accountItemId: 3, partnerKey: null }),
      row({ accountItemId: 4, partnerKey: "SOLO" }),
      row({ accountItemId: 5, partnerKey: "PAIR" }),
      row({ accountItemId: 5, partnerKey: "PAIR" }),
    ];
    const r = aggregatePastQuality(rows);
    const ids = [
      ...r.variantGroups.flatMap((g) => g.accounts.flatMap((a) => a.entryIds)),
      ...r.stableAccountCandidates.flatMap((c) => c.entryIds),
      ...r.missingKey.entryIds,
    ];
    expect(ids.sort()).toEqual(rows.map((x) => x.id).sort());
  });

  describe("stableAccountCandidates（ルール検討用）", () => {
    it("科目が1種類のグループを、科目ID・件数・期間・根拠IDつきで返す", () => {
      const r = aggregatePastQuality([
        row({ id: "b", accountItemId: 100, entryDate: "2026-03-01" }),
        row({ id: "a", accountItemId: 100, entryDate: "2026-01-05" }),
      ]);
      expect(r.stableAccountCandidates).toEqual([
        {
          kind: "rule-consideration-candidate",
          direction: "expense",
          partnerKey: "ACME",
          accountItemId: 100,
          count: 2,
          dateRange: { from: "2026-01-05", to: "2026-03-01" },
          entryIds: ["a", "b"],
        },
      ]);
      // 税区分・補助科目・金額条件などは推測して持たない
      expect(Object.keys(r.stableAccountCandidates[0] ?? {}).sort()).toEqual(
        ["accountItemId", "count", "dateRange", "direction", "entryIds", "kind", "partnerKey"].sort(),
      );
    });

    it("向きとキー（保存値の完全一致）ごとに別の候補になり、混ぜない", () => {
      const r = aggregatePastQuality([
        row({ id: "x1", accountItemId: 100, direction: "expense" }),
        row({ id: "x2", accountItemId: 200, direction: "income" }),
        row({ id: "x3", accountItemId: 300, partnerKey: "ACME " }),
        row({ id: "x4", accountItemId: 400, partnerKey: "acme" }),
      ]);
      expect(r.stableAccountCandidates.map((c) => [c.direction, c.partnerKey, c.accountItemId, c.entryIds])).toEqual([
        ["expense", "ACME", 100, ["x1"]],
        ["expense", "ACME ", 300, ["x3"]],
        ["expense", "acme", 400, ["x4"]],
        ["income", "ACME", 200, ["x2"]],
      ]);
    });

    it("1件だけでも候補から落とさず、件数をそのまま返す（足切り・確度の付与なし）", () => {
      const r = aggregatePastQuality([row({ id: "one", accountItemId: 100 })]);
      expect(r.stableAccountCandidates).toHaveLength(1);
      expect(r.stableAccountCandidates[0]).toMatchObject({ count: 1, entryIds: ["one"] });
      expect(r.stableAccountCandidates[0]).not.toHaveProperty("confidence");
    });

    it("科目が分かれたグループとキーのない仕訳は候補に入らない", () => {
      const r = aggregatePastQuality([
        row({ partnerKey: "MIX", accountItemId: 1 }),
        row({ partnerKey: "MIX", accountItemId: 2 }),
        row({ partnerKey: null, accountItemId: 3 }),
        row({ partnerKey: "  ", accountItemId: 3 }),
      ]);
      expect(r.stableAccountCandidates).toEqual([]);
      expect(r.variantGroups).toHaveLength(1);
      expect(r.missingKey.count).toBe(2);
    });

    it("件数の多い順、同数は向き・キー順で、入力順に依らず同じ結果で、入力を変更しない", () => {
      const rows = [
        row({ partnerKey: "B", accountItemId: 1 }),
        row({ partnerKey: "A", accountItemId: 1 }),
        row({ partnerKey: "A", accountItemId: 1, direction: "income" }),
        row({ partnerKey: "Z", accountItemId: 1 }),
        row({ partnerKey: "Z", accountItemId: 1 }),
      ];
      const copy = structuredClone(rows);
      const a = aggregatePastQuality(rows);
      expect(rows).toEqual(copy);
      expect(aggregatePastQuality([...rows].reverse())).toEqual(a);
      expect(a.stableAccountCandidates.map((c) => [c.partnerKey, c.direction])).toEqual([
        ["Z", "expense"],
        ["A", "expense"],
        ["B", "expense"],
        ["A", "income"],
      ]);
    });
  });

  it("同じ過去仕訳IDが重複していたら例外にする", () => {
    expect(() => aggregatePastQuality([row({ id: "x", accountItemId: 1 }), row({ id: "x", accountItemId: 2 })])).toThrow(/重複/);
  });
});
