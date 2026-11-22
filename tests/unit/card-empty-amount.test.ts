import { describe, expect, it, vi } from "vitest";
import { findStatementFormat } from "@/lib/statements/formats";
import { importStatementCsv, type StatementImportGateway } from "@/lib/statements/import";
import { parseStatementCsv } from "@/lib/statements/parse";

// 期待の記録: docs/reviews/2026-11-05-card-empty-amount.md（架空の合成データだけを使う）
const CUSTOMER = "10000000-0000-4000-8000-000000000001";
const WALLET = "20000000-0000-4000-8000-000000000002";
const card = findStatementFormat("card_generic")!;
const bank = findStatementFormat("bank_generic")!;

const HEADER = "利用日,利用店名,利用金額";
const cardCsv = (amount: string) => [HEADER, "2026/11/01,架空店A,980", `2026/11/02,架空店B,${amount}`, "2026/11/03,架空店C,-300"].join("\n");

const BLANKS: [string, string][] = [
  ["空文字", ""],
  ["ASCII 空白", "   "],
  ["全角空白", "　　"],
  ["クオートされた空欄", '""'],
];

describe("カード形式: 金額欄が空欄の行は金額0にせずエラーにする", () => {
  it.each(BLANKS)("%s: 3行目のエラー。ignored にも rows にも入れず、ほかの行は読む", (_label, amount) => {
    const result = parseStatementCsv(cardCsv(amount), card);
    expect(result.errors).toEqual([{ line: 3, message: expect.stringContaining("金額が空欄") }]);
    expect(result.ignored).toEqual([]);
    expect(result.rows.map((r) => [r.line, r.direction, r.amount])).toEqual([
      [2, "expense", 980],
      [4, "income", 300],
    ]);
    expect(result.sourceRowCount).toBe(3);
  });

  it("前置きの行・空行・クオート内の改行があっても、行番号は物理行", () => {
    const csv = ["架空カード 利用明細", "", HEADER, '"2026/11/01","架空店\nA",980', "2026/11/02,架空店B,  "].join("\n");
    const result = parseStatementCsv(csv, card);
    expect(result.errors).toEqual([{ line: 6, message: expect.stringContaining("金額が空欄") }]);
    expect(result.ignored).toEqual([]);
    expect(result.rows.map((r) => r.line)).toEqual([4]);
  });
});

describe("カード形式: 明示的な金額は従来どおり", () => {
  it.each([
    ["0", "0"],
    ["全角の０", "０"],
  ])("%s は金額0として ignored（エラーにしない）", (_label, amount) => {
    const result = parseStatementCsv(cardCsv(amount), card);
    expect(result.errors).toEqual([]);
    expect(result.ignored).toEqual([{ line: 3, reason: expect.stringContaining("金額が0") }]);
    expect(result.rows.map((r) => r.line)).toEqual([2, 4]);
    expect(result.sourceRowCount).toBe(3);
  });

  it("正の利用金額は支出、負の金額は返金（入金）", () => {
    const result = parseStatementCsv(`${HEADER}\n2026/11/01,架空店A,980\n2026/11/02,架空店B返金,-300`, card);
    expect(result.errors).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.rows.map((r) => [r.direction, r.amount])).toEqual([
      ["expense", 980],
      ["income", 300],
    ]);
  });
});

describe("銀行形式: 出金・入金の空欄の扱いは変えない", () => {
  const BANK_HEADER = "日付,摘要,出金,入金";

  it("両方空欄（空白・クオートを含む）は金額0として ignored。エラーにしない", () => {
    const csv = [BANK_HEADER, "2026/11/01,残高照会,,", '2026/11/02,残高確認B,"", ', "2026/11/03,架空支払,100,"].join("\n");
    const result = parseStatementCsv(csv, bank);
    expect(result.errors).toEqual([]);
    expect(result.ignored).toEqual([
      { line: 2, reason: expect.stringContaining("金額が0") },
      { line: 3, reason: expect.stringContaining("金額が0") },
    ]);
    expect(result.rows.map((r) => [r.line, r.amount])).toEqual([[4, 100]]);
    expect(result.sourceRowCount).toBe(3);
  });

  it("片方だけ空欄は、値のある側で取引になる", () => {
    const result = parseStatementCsv(`${BANK_HEADER}\n2026/11/01,架空支払,100,\n2026/11/02,架空入金,,500`, bank);
    expect(result.errors).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.rows.map((r) => [r.line, r.direction, r.amount])).toEqual([
      [2, "expense", 100],
      [3, "income", 500],
    ]);
  });
});

describe("importStatementCsv: カードの空欄の金額はファイル全体の失敗", () => {
  const target = (text: string) => ({
    customerId: CUSTOMER,
    walletId: WALLET,
    fileName: "card-empty-amount.csv",
    formatId: "card_generic",
    walletKind: "credit_card" as const,
    bytes: new TextEncoder().encode(`﻿${text}`),
  });
  const newGateway = () => {
    const importRows = vi.fn<StatementImportGateway["importRows"]>(async () => {
      throw new Error("importRows が呼ばれてはいけない");
    });
    const recordFailure = vi.fn<StatementImportGateway["recordFailure"]>(async () => "30000000-0000-4000-8000-000000000003");
    return { importRows, recordFailure };
  };

  it.each(BLANKS)("%s: importRows を呼ばず、recordFailure を3行目・件数3で1回だけ呼ぶ", async (_label, amount) => {
    const gateway = newGateway();
    const result = await importStatementCsv(target(cardCsv(amount)), gateway);
    expect(result).toMatchObject({ ok: false, failureRecordId: "30000000-0000-4000-8000-000000000003" });
    expect(gateway.importRows).not.toHaveBeenCalled();
    expect(gateway.recordFailure).toHaveBeenCalledTimes(1);
    expect(gateway.recordFailure).toHaveBeenCalledWith({
      customerId: CUSTOMER,
      walletId: WALLET,
      fileName: "card-empty-amount.csv",
      formatId: "card_generic",
      sourceRowCount: 3,
      errors: [{ line: 3, message: expect.stringContaining("金額が空欄") }],
    });
  });

  it("明示的な0は従来どおり取り込み、ignored に3行目を渡す（recordFailure は呼ばない）", async () => {
    const importRows = vi.fn<StatementImportGateway["importRows"]>(async () => ({
      importId: "40000000-0000-4000-8000-000000000004",
      insertedCount: 2,
      skippedDuplicateCount: 0,
      suspectedDuplicateCount: 0,
      incomeTotal: 300,
      expenseTotal: 980,
      insertedAmountTotal: 1280,
      skippedAmountTotal: 0,
      suspectedAmountTotal: 0,
    }));
    const recordFailure = vi.fn<StatementImportGateway["recordFailure"]>(async () => "unused");
    const result = await importStatementCsv(target(cardCsv("０")), { importRows, recordFailure });
    expect(result).toMatchObject({ ok: true, insertedCount: 2, ignoredCount: 1 });
    expect(recordFailure).not.toHaveBeenCalled();
    expect(importRows).toHaveBeenCalledTimes(1);
    expect(importRows).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRowCount: 3,
        ignored: [{ line: 3, reason: expect.stringContaining("金額が0") }],
        rows: [
          expect.objectContaining({ direction: "expense", amount: 980 }),
          expect.objectContaining({ direction: "income", amount: 300 }),
        ],
      }),
    );
  });
});
