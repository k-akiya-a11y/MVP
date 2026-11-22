import { describe, expect, it, vi } from "vitest";
import { findStatementFormat } from "@/lib/statements/formats";
import { importStatementCsv, type StatementImportGateway } from "@/lib/statements/import";
import { parseStatementCsv } from "@/lib/statements/parse";

// 期待の記録: docs/reviews/2026-11-05-zero-row-balance-validation.md（架空の合成データだけを使う）
const WALLET = "20000000-0000-4000-8000-000000000001";
const bank = findStatementFormat("bank_generic")!;
const card = findStatementFormat("card_generic")!;

const HEADER = "日付,摘要,出金,入金,残高";
const VALID_ROW = '2026/11/01,架空支払,1200,,"8,800"';
const encode = (text: string) => new TextEncoder().encode("﻿" + text);

function gateway() {
  const importRows = vi.fn<StatementImportGateway["importRows"]>(async () => {
    throw new Error("importRows が呼ばれてはいけない");
  });
  const recordFailure = vi.fn<StatementImportGateway["recordFailure"]>(async () => "fail-1");
  return { importRows, recordFailure };
}

describe("金額0の行の残高が不正なら、有効な取引と混ざっていてもその行のエラーにする", () => {
  it.each([
    ["桁区切りの位置が不正（1,23）", '"1,23"', "金額を整数の円として読めません"],
    ["桁区切りの位置が不正（12,34,567）", '"12,34,567"', "金額を整数の円として読めません"],
    ["数字でない文字", "abc", "金額を整数の円として読めません"],
    ["安全な整数を超える", "9007199254740993", "金額が大きすぎます"],
  ])("銀行: %s", (_name, balance, message) => {
    const csv = [HEADER, VALID_ROW, `2026/11/02,残高照会,,,${balance}`, '2026/11/03,架空入金,,500,"9,300"'].join("\n");
    const result = parseStatementCsv(csv, bank);
    expect(result.errors).toEqual([{ line: 3, message: expect.stringContaining(message) }]);
    expect(result.ignored).toEqual([]);
    expect(result.rows.map((r) => r.line)).toEqual([2, 4]);
    expect(result.sourceRowCount).toBe(3);
  });

  it("金額欄が明示的な 0 の行でも、残高が不正ならエラー", () => {
    const csv = [HEADER, '2026/11/02,残高照会,0,0,"1,23"'].join("\n");
    const result = parseStatementCsv(csv, bank);
    expect(result.errors).toEqual([{ line: 2, message: expect.stringContaining("金額を整数の円として読めません") }]);
    expect(result.ignored).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.sourceRowCount).toBe(1);
  });

  it("金額0の行が複数あれば、不正な残高の行だけが行番号つきでエラーになる", () => {
    const csv = [HEADER, '2026/11/01,残高照会,,,"1,000"', '2026/11/02,残高照会,,,"1,23"', "2026/11/03,残高照会,,,"].join("\n");
    const result = parseStatementCsv(csv, bank);
    expect(result.errors).toEqual([{ line: 3, message: expect.any(String) }]);
    expect(result.ignored.map((i) => i.line)).toEqual([2, 4]);
    expect(result.sourceRowCount).toBe(3);
  });

  it("金額が0でない行の不正な残高は従来どおりエラー（変わらない）", () => {
    const result = parseStatementCsv([HEADER, '2026/11/01,架空支払,1200,,"1,23"'].join("\n"), bank);
    expect(result.errors).toEqual([{ line: 2, message: expect.stringContaining("金額を整数の円として読めません") }]);
    expect(result.rows).toEqual([]);
  });
});

describe("有効な金額0の行・残高なしは従来どおり", () => {
  it("金額0で残高が正しい行・空欄の行は ignored（取引にしない）", () => {
    const csv = [HEADER, VALID_ROW, '2026/11/02,残高照会,,,"1,000"', "2026/11/03,残高照会,,,"].join("\n");
    const result = parseStatementCsv(csv, bank);
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => [r.line, r.amount, r.balance])).toEqual([[2, 1200, 8800]]);
    expect(result.ignored).toEqual([
      { line: 3, reason: "金額が0（残高照会などの行）" },
      { line: 4, reason: "金額が0（残高照会などの行）" },
    ]);
    expect(result.sourceRowCount).toBe(3);
  });

  it("残高の列がない見出しは有効で、balance は null", () => {
    const result = parseStatementCsv("日付,摘要,出金,入金\n2026/11/01,架空支払,1200,\n2026/11/02,残高照会,,", bank);
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => [r.amount, r.balance])).toEqual([[1200, null]]);
    expect(result.ignored).toEqual([{ line: 3, reason: "金額が0（残高照会などの行）" }]);
  });

  it("残高の列はあるが取引行の残高欄が空欄でも有効で、balance は null", () => {
    const result = parseStatementCsv([HEADER, "2026/11/01,架空支払,1200,,"].join("\n"), bank);
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => r.balance)).toEqual([null]);
  });
});

describe("カード（符号付き金額・残高列なし）の金額0の扱いは変わらない", () => {
  it("0 と △0 は ignored、返金（-500）は income、利用は expense", () => {
    const csv = ["利用日,利用店名,利用金額", "2026/11/01,架空店,980", "2026/11/02,架空店,0", "2026/11/03,架空店,△0", "2026/11/04,架空返金,-500"].join("\n");
    const result = parseStatementCsv(csv, card);
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => [r.line, r.direction, r.amount, r.balance])).toEqual([
      [2, "expense", 980, null],
      [5, "income", 500, null],
    ]);
    expect(result.ignored.map((i) => i.line)).toEqual([3, 4]);
    expect(result.sourceRowCount).toBe(4);
  });
});

describe("importStatementCsv: 金額0の行の不正な残高はファイル全体の失敗", () => {
  const target = (text: string) => ({
    customerId: "customer-1",
    walletId: WALLET,
    fileName: "zero-row.csv",
    formatId: "bank_generic",
    walletKind: "bank_account" as const,
    bytes: encode(text),
  });

  it("importRows を呼ばず、recordFailure に不正な行の行番号・理由・件数を渡す", async () => {
    const g = gateway();
    // 前置き1行 + 見出し(2行目) + 有効な取引(3行目) + 金額0で残高が不正(4行目) + 有効な取引(5行目)
    const csv = ["架空銀行 取引明細", HEADER, VALID_ROW, '2026/11/02,残高照会,,,"1,23"', '2026/11/03,架空入金,,500,"9,300"'].join("\n");
    const result = await importStatementCsv(target(csv), g);
    expect(result).toMatchObject({ ok: false, failureRecordId: "fail-1" });
    expect(g.importRows).not.toHaveBeenCalled();
    expect(g.recordFailure).toHaveBeenCalledTimes(1);
    expect(g.recordFailure).toHaveBeenCalledWith({
      customerId: "customer-1",
      walletId: WALLET,
      fileName: "zero-row.csv",
      formatId: "bank_generic",
      sourceRowCount: 3,
      errors: [{ line: 4, message: expect.stringContaining("金額を整数の円として読めません") }],
    });
  });

  it("安全な整数を超える残高も同様に全体失敗", async () => {
    const g = gateway();
    const csv = [HEADER, VALID_ROW, "2026/11/02,残高照会,,,9007199254740993"].join("\n");
    const result = await importStatementCsv(target(csv), g);
    expect(result).toMatchObject({ ok: false });
    expect(g.importRows).not.toHaveBeenCalled();
    expect(g.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRowCount: 2, errors: [{ line: 3, message: expect.stringContaining("金額が大きすぎます") }] }),
    );
  });

  it("残高が正しい金額0の行を含む同じ形のファイルは取り込める（比較）", async () => {
    const importRows = vi.fn<StatementImportGateway["importRows"]>(async () => ({
      importId: "imp-1",
      insertedCount: 1,
      skippedDuplicateCount: 0,
      suspectedDuplicateCount: 0,
      incomeTotal: 0,
      expenseTotal: 1200,
      insertedAmountTotal: 1200,
      skippedAmountTotal: 0,
      suspectedAmountTotal: 0,
    }));
    const recordFailure = vi.fn<StatementImportGateway["recordFailure"]>(async () => "fail-1");
    const csv = [HEADER, VALID_ROW, '2026/11/02,残高照会,,,"8,800"'].join("\n");
    const result = await importStatementCsv(target(csv), { importRows, recordFailure });
    expect(result).toMatchObject({ ok: true, insertedCount: 1, ignoredCount: 1 });
    expect(recordFailure).not.toHaveBeenCalled();
    expect(importRows.mock.calls[0]![0].ignored).toEqual([{ line: 3, reason: "金額が0（残高照会などの行）" }]);
  });
});
