import { describe, expect, it } from "vitest";
import { NO_FILTERS, TXN_STATUSES, isFiltered, isRealDate, ledgerHref, parseLedgerFilters } from "@/lib/statements/ledger";

const CID = "11111111-1111-4111-8111-111111111111";
const W1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("取引日の検証", () => {
  it("実在する日付だけを通す（閏日・月末を含む）", () => {
    for (const d of ["2026-10-31", "2024-02-29", "2000-02-29", "2026-02-28", "2026-12-31", "0001-01-01"]) expect(isRealDate(d)).toBe(true);
    for (const d of ["2026-02-29", "2100-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-10-00", "2026-10-32", "0000-01-01"]) {
      expect(isRealDate(d)).toBe(false);
    }
    for (const d of ["2026/10/01", "2026-1-1", "20261001", " 2026-10-01", "2026-10-01 ", "2026-10-01T00:00", "２０２６-10-01", ""]) expect(isRealDate(d)).toBe(false);
  });
});

describe("絞り込みの解釈", () => {
  it("未指定・空・status=all は指定なしで、エラーにならない", () => {
    expect(parseLedgerFilters({})).toEqual({ filters: NO_FILTERS, errors: [] });
    expect(parseLedgerFilters({ status: "", wallet: "", from: "", to: "" })).toEqual({ filters: NO_FILTERS, errors: [] });
    expect(parseLedgerFilters({ status: "all" })).toEqual({ filters: NO_FILTERS, errors: [] });
    expect(isFiltered(NO_FILTERS)).toBe(false);
  });

  it("既存 8 状態は全て受け付ける", () => {
    for (const s of TXN_STATUSES) expect(parseLedgerFilters({ status: s })).toEqual({ filters: { ...NO_FILTERS, status: s }, errors: [] });
    expect(TXN_STATUSES).toHaveLength(8);
  });

  it("有効な複合条件。閏日も通り、開始日=終了日も通る。口座IDは小文字に正規化", () => {
    const r = parseLedgerFilters({ status: "new", wallet: W1.toUpperCase(), from: "2024-02-29", to: "2024-02-29" });
    expect(r.errors).toEqual([]);
    expect(r.filters).toEqual({ status: "new", walletId: W1, from: "2024-02-29", to: "2024-02-29" });
    expect(isFiltered(r.filters)).toBe(true);
  });

  it("不正な状態・口座・日付はエラーにし、黙って捨てない。エラー文に入力値を含めない", () => {
    const evil = "<script>x</script>'; drop table";
    for (const p of [{ status: "mystery" }, { status: evil }, { wallet: "not-a-uuid" }, { wallet: evil }, { from: "2026-02-29" }, { to: "2026-13-01" }, { from: evil }, { to: "2026-04-31" }]) {
      const r = parseLedgerFilters(p);
      expect(r.errors).toHaveLength(1);
      expect(r.filters).toEqual(NO_FILTERS);
      expect(r.errors.join("")).not.toContain("script");
      expect(r.errors.join("")).not.toContain("mystery");
      expect(r.errors.join("")).not.toContain(Object.values(p)[0]!);
    }
  });

  it("開始日が終了日より後（逆順）はエラー。有効な各項目は filters に残る", () => {
    const r = parseLedgerFilters({ from: "2026-10-31", to: "2026-10-01" });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("開始日");
    expect(r.filters.from).toBe("2026-10-31");
    expect(r.filters.to).toBe("2026-10-01");
  });

  it("同じ名前の複数指定（配列）は、値が同じでもエラー", () => {
    for (const k of ["status", "wallet", "from", "to"] as const) {
      const r = parseLedgerFilters({ [k]: ["new", "new"] } as never);
      expect(r.errors).toHaveLength(1);
      expect(r.filters).toEqual(NO_FILTERS);
    }
  });

  it("複数の誤りは全て返す（1つ直すと次が出る、にしない）", () => {
    expect(parseLedgerFilters({ status: "x", wallet: "y", from: "z", to: "w" }).errors).toHaveLength(4);
  });
});

describe("一覧のURL組立", () => {
  const base = `/customers/${CID}/statements`;

  it("絞り込みなしの 1 ページ目はクエリなし。リセットのリンクもこれ", () => {
    expect(ledgerHref(CID, NO_FILTERS, 1)).toBe(base);
  });

  it("ページ送りでも有効な絞り込みを保持し、1 ページ目には page を付けない", () => {
    const f = { status: "new" as const, walletId: W1, from: "2026-10-01", to: "2026-10-31" };
    const u = new URL(ledgerHref(CID, f, 3), "http://x");
    expect(u.pathname).toBe(base);
    expect(Object.fromEntries(u.searchParams)).toEqual({ status: "new", wallet: W1, from: "2026-10-01", to: "2026-10-31", page: "3" });
    expect(new URL(ledgerHref(CID, f, 1), "http://x").searchParams.has("page")).toBe(false);
    expect(new URL(ledgerHref(CID, f, 1), "http://x").searchParams.get("status")).toBe("new");
  });

  it("指定のない項目はクエリに出さない", () => {
    expect(ledgerHref(CID, { ...NO_FILTERS, from: "2026-10-01" }, 2)).toBe(`${base}?from=2026-10-01&page=2`);
  });
});
