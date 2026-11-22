import { describe, expect, it, vi } from "vitest";
import { findStatementFormat } from "@/lib/statements/formats";
import { importStatementCsv, type StatementImportGateway } from "@/lib/statements/import";
import { parseStatementCsv } from "@/lib/statements/parse";
import { parseYen } from "@/lib/statements/values";

// 期待の記録: docs/reviews/2026-11-05-yen-format-validation.md（架空の合成データだけを使う）
const WALLET = "20000000-0000-4000-8000-000000000001";
const NOT_INTEGER = /金額を整数の円として読めません/;
const TOO_LARGE = /金額が大きすぎます/;

describe("parseYen: 文書化された日本円の整数表記は受け付ける", () => {
  it.each([
    ["1234", 1234],
    ["1,234", 1234],
    ["12,345,678", 12345678],
    ["999", 999],
    ["￥1,234", 1234],
    ["¥ 1,234円", 1234],
    ["¥1,234円", 1234],
    ["1,234円", 1234],
    ["1,234 円", 1234],
    ["\\1,234", 1234],
    ["\\ 1,234円", 1234],
    ["＼1,234", 1234],
    ["１，２３４", 1234],
    ["１２３", 123],
    ["  1,234  ", 1234],
    ["-500", -500],
    ["△500", -500],
    ["▲500", -500],
    ["(500)", -500],
    ["（500）", -500],
    ["－500", -500],
    ["-1,234", -1234],
    ["△1,234円", -1234],
    ["(1,234)", -1234],
    ["(¥1,234円)", -1234],
    ["- ¥ 1,234 円", -1234],
    ["( ¥1,234円 )", -1234],
    ["△\\1,234", -1234],
  ])("%j → %s", (raw, expected) => {
    expect(parseYen(raw)).toBe(expected);
  });

  it("空欄（空白だけを含む）は金額なし（null）", () => {
    expect(parseYen("")).toBeNull();
    expect(parseYen("   ")).toBeNull();
    expect(parseYen("\t")).toBeNull();
  });

  it("0 は有効（符号付きでも値は0）", () => {
    expect(parseYen("0")).toBe(0);
    expect(parseYen("０")).toBe(0);
    expect(parseYen("0円")).toBe(0);
    // -0 の符号は文書化されていないので、値が0であることだけを見る
    expect(parseYen("-0") === 0).toBe(true);
    expect(parseYen("(0)") === 0).toBe(true);
  });

  it("安全な整数の範囲までは、カンマの有無にかかわらず受け付ける", () => {
    expect(parseYen("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseYen("9,007,199,254,740,991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseYen("-9007199254740991")).toBe(-Number.MAX_SAFE_INTEGER);
    expect(parseYen("△9,007,199,254,740,991")).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it("安全な整数を超える金額は「大きすぎます」の誤り", () => {
    expect(() => parseYen("9007199254740992")).toThrow(TOO_LARGE);
    expect(() => parseYen("9,007,199,254,740,992")).toThrow(TOO_LARGE);
    expect(() => parseYen("-9007199254740992")).toThrow(TOO_LARGE);
  });
});

describe("parseYen: 壊れた書式は別の金額にせず、整数の誤りにする", () => {
  describe("カンマの位置が3桁区切りでない", () => {
    it.each(["1,23", "1,2345", ",123", "123,", "1,,234", "12,34,567", "1234,567", "1,234,56", "1,234,", "１，２３", "-1,23", "(1,,234)"])(
      "%j",
      (raw) => {
        expect(() => parseYen(raw)).toThrow(NOT_INTEGER);
      },
    );
  });

  describe("数字の途中・重複・位置違いの通貨記号", () => {
    it.each(["1円2", "1¥2", "1,234円5", "¥¥1,234", "\\¥1,234", "¥\\1,234", "1,234円円", "円1,234", "1,234¥", "1,234円¥", "¥1,2¥34", "￥￥1,234"])(
      "%j",
      (raw) => {
        expect(() => parseYen(raw)).toThrow(NOT_INTEGER);
      },
    );
  });

  describe("数字の内側の空白・タブ・改行を黙って連結しない", () => {
    it.each(["1 2", "1 234", "12 345", "1,234 567", "1\t2", "1\n2", "1\r\n2", "1　2", "¥1 234円", "1,2 34"])("%j", (raw) => {
      expect(() => parseYen(raw)).toThrow(NOT_INTEGER);
    });
  });

  describe("既存どおり受け付けない書式", () => {
    it.each(["100.5", "1,234.00", "+500", "1e3", "$1,234", "abc", "1,234円abc", "--500", "△-500", "(500", "500)", "((500))", "-", "¥", "円", "()"])(
      "%j",
      (raw) => {
        expect(() => parseYen(raw)).toThrow(NOT_INTEGER);
      },
    );
  });
});

// ---- 取込（実際の parseStatementCsv / importStatementCsv、モックのゲートウェイ）----

const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
const bom = (text: string) => new TextEncoder().encode(`﻿${text}`);

const BANK_HEADER = "日付,摘要,出金,入金,残高";
const CARD_HEADER = "利用日,利用店名,利用金額";
const bankRow = (date: string, desc: string, out: string, inn: string, balance: string) => [date, desc, q(out), q(inn), q(balance)].join(",");
const cardRow = (date: string, desc: string, amount: string) => [date, desc, q(amount)].join(",");

function gateway() {
  const importRows = vi.fn<StatementImportGateway["importRows"]>(async ({ rows }) => {
    const sum = (d: string) => rows.filter((r) => r.direction === d).reduce((a, r) => a + r.amount, 0);
    return {
      importId: "imp-1",
      insertedCount: rows.length,
      skippedDuplicateCount: 0,
      suspectedDuplicateCount: 0,
      incomeTotal: sum("income"),
      expenseTotal: sum("expense"),
      insertedAmountTotal: sum("income") + sum("expense"),
      skippedAmountTotal: 0,
      suspectedAmountTotal: 0,
    };
  });
  const recordFailure = vi.fn<StatementImportGateway["recordFailure"]>(async () => "fail-1");
  return { importRows, recordFailure };
}

const bankInput = (text: string) => ({
  customerId: "customer-1",
  walletId: WALLET,
  fileName: "synthetic-bank.csv",
  formatId: "bank_generic",
  walletKind: "bank_account" as const,
  bytes: bom(text),
});
const cardInput = (text: string) => ({
  customerId: "customer-1",
  walletId: WALLET,
  fileName: "synthetic-card.csv",
  formatId: "card_generic",
  walletKind: "credit_card" as const,
  bytes: bom(text),
});

/** 有効な行（2行目）、壊れた行（3行目）、有効な行（4行目）の3行 */
const bankCsvWithBad = (bad: string) => [BANK_HEADER, bankRow("2026/10/01", "A商事", "1,000", "", "9,000"), bad, bankRow("2026/10/03", "C商事", "", "3,000", "12,000")].join("\n") + "\n";
const cardCsvWithBad = (bad: string) => [CARD_HEADER, cardRow("2026/10/01", "A店", "1,000"), bad, cardRow("2026/10/03", "C店", "3,000")].join("\n") + "\n";

describe("取込: 壊れた金額の行があればファイル全体を取り込まない", () => {
  type Case = { name: string; csv: string; input: typeof bankInput | typeof cardInput };
  const cases: Case[] = [
    { name: "出金 1,23", csv: bankCsvWithBad(bankRow("2026/10/02", "B商事", "1,23", "", "8,000")), input: bankInput },
    { name: "出金 1円2", csv: bankCsvWithBad(bankRow("2026/10/02", "B商事", "1円2", "", "8,000")), input: bankInput },
    { name: "入金 1,,234", csv: bankCsvWithBad(bankRow("2026/10/02", "B商事", "", "1,,234", "8,000")), input: bankInput },
    { name: "入金 1 2", csv: bankCsvWithBad(bankRow("2026/10/02", "B商事", "", "1 2", "8,000")), input: bankInput },
    { name: "金額が0でない行の残高 1,23", csv: bankCsvWithBad(bankRow("2026/10/02", "B商事", "500", "", "1,23")), input: bankInput },
    { name: "金額が0でない行の残高 1 2", csv: bankCsvWithBad(bankRow("2026/10/02", "B商事", "", "500", "1 2")), input: bankInput },
    { name: "カード符号付き金額 1,23", csv: cardCsvWithBad(cardRow("2026/10/02", "B店", "1,23")), input: cardInput },
    { name: "カード符号付き金額 △1,,234", csv: cardCsvWithBad(cardRow("2026/10/02", "B店", "△1,,234")), input: cardInput },
    { name: "カード符号付き金額 1円2", csv: cardCsvWithBad(cardRow("2026/10/02", "B店", "1円2")), input: cardInput },
    { name: "カード符号付き金額 (1 2)", csv: cardCsvWithBad(cardRow("2026/10/02", "B店", "(1 2)")), input: cardInput },
  ];

  it.each(cases)("$name: parseStatementCsv は3行目を errors にする", ({ csv, input }) => {
    const format = findStatementFormat(input === bankInput ? "bank_generic" : "card_generic")!;
    const result = parseStatementCsv(csv, format);
    expect(result.errors).toEqual([{ line: 3, message: expect.stringMatching(NOT_INTEGER) }]);
    expect(result.sourceRowCount).toBe(3);
    // 壊れた行は別の金額の取引にならない
    expect(result.rows.map((r) => r.line)).toEqual([2, 4]);
  });

  it.each(cases)("$name: importRows を呼ばず、recordFailure に理由・行番号・件数を渡す", async ({ csv, input }) => {
    const g = gateway();
    const target = input(csv);
    const result = await importStatementCsv(target, g);
    expect(result).toMatchObject({ ok: false, failureRecordId: "fail-1" });
    expect(g.importRows).not.toHaveBeenCalled();
    expect(g.recordFailure).toHaveBeenCalledTimes(1);
    expect(g.recordFailure).toHaveBeenCalledWith({
      customerId: "customer-1",
      walletId: WALLET,
      fileName: target.fileName,
      formatId: target.formatId,
      sourceRowCount: 3,
      errors: [{ line: 3, message: expect.stringMatching(NOT_INTEGER) }],
    });
  });

  it("壊れた行が複数あれば、すべての行番号を記録する（有効な行は errors に入らない）", async () => {
    const g = gateway();
    const csv = [
      BANK_HEADER,
      bankRow("2026/10/01", "A商事", "1,000", "", "9,000"),
      bankRow("2026/10/02", "B商事", "1,23", "", "8,000"),
      bankRow("2026/10/03", "C商事", "", "3,000", "1,,234"),
    ].join("\n");
    const result = await importStatementCsv(bankInput(csv), g);
    expect(result).toMatchObject({ ok: false });
    expect(g.importRows).not.toHaveBeenCalled();
    expect(g.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRowCount: 3,
        errors: [
          { line: 3, message: expect.stringMatching(NOT_INTEGER) },
          { line: 4, message: expect.stringMatching(NOT_INTEGER) },
        ],
      }),
    );
  });

  it("セル内に改行がある金額は連結せず誤りにする（行番号はその行の開始位置）", async () => {
    const g = gateway();
    const csv = [BANK_HEADER, bankRow("2026/10/01", "A商事", "1,000", "", "9,000"), bankRow("2026/10/02", "B商事", "1\n2", "", "8,000")].join("\n") + "\n";
    const result = await importStatementCsv(bankInput(csv), g);
    expect(result).toMatchObject({ ok: false });
    expect(g.importRows).not.toHaveBeenCalled();
    expect(g.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRowCount: 2, errors: [{ line: 3, message: expect.stringMatching(NOT_INTEGER) }] }),
    );
  });
});

describe("取込: 文書化された書式の金額は従来どおり取り込める", () => {
  it("銀行: 通貨記号・全角・符号・空欄の残高を含む有効な行をそのまま登録する", async () => {
    const g = gateway();
    const csv = [
      BANK_HEADER,
      bankRow("2026/10/01", "A商事", "¥ 1,234円", "", "￥1,234,567"),
      bankRow("2026/10/02", "B商事", "", "１，５００", ""),
      bankRow("2026/10/03", "C商事", "\\2,000", "", "(500)"),
    ].join("\n");
    const result = await importStatementCsv(bankInput(csv), g);
    expect(result).toMatchObject({ ok: true, insertedCount: 3 });
    expect(g.recordFailure).not.toHaveBeenCalled();
    const args = g.importRows.mock.calls[0]![0];
    expect(args.sourceRowCount).toBe(3);
    expect(args.rows.map((r) => [r.amount, r.direction, r.balance])).toEqual([
      [1234, "expense", 1234567],
      [1500, "income", null],
      [2000, "expense", -500],
    ]);
  });

  it("カード: 符号付きの利用金額（△・括弧・マイナス）は返金（入金）にする", async () => {
    const g = gateway();
    const csv = [CARD_HEADER, cardRow("2026/10/01", "A店", "¥3,980円"), cardRow("2026/10/02", "B店", "△1,500"), cardRow("2026/10/03", "C店", "(2,000)"), cardRow("2026/10/04", "D店", "-300")].join("\n");
    const result = await importStatementCsv(cardInput(csv), g);
    expect(result).toMatchObject({ ok: true, insertedCount: 4 });
    const args = g.importRows.mock.calls[0]![0];
    expect(args.rows.map((r) => [r.amount, r.direction])).toEqual([
      [3980, "expense"],
      [1500, "income"],
      [2000, "income"],
      [300, "income"],
    ]);
  });
});
