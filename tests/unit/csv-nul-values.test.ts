import { describe, expect, it, vi } from "vitest";
import { findStatementFormat } from "@/lib/statements/formats";
import { importStatementCsv, type StatementImportGateway } from "@/lib/statements/import";
import { parseStatementCsv } from "@/lib/statements/parse";
import { parseStatementDate, parseYen } from "@/lib/statements/values";

// 期待の記録: docs/reviews/2026-11-05-csv-nul-values.md（架空の合成データだけを使う）
const CUSTOMER = "10000000-0000-4000-8000-000000000001";
const WALLET = "20000000-0000-4000-8000-000000000002";
const FAILURE_ID = "30000000-0000-4000-8000-000000000003";
const NUL = "\u0000";
const bank = findStatementFormat("bank_generic")!;
const card = findStatementFormat("card_generic")!;

const BANK_HEADER = "日付,摘要,出金,入金,残高";
const CARD_HEADER = "利用日,利用店名,利用金額";

/** 実際の NUL、または JSON に直したときの \u0000 の表記が残っていないこと */
const hasNul = (s: string) => s.includes(NUL) || s.includes("\\u0000");
const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("例外が投げられなかった");
};

describe("values.ts: NUL を含む日付・金額は、NUL を含まない固定の日本語エラーで拒否する", () => {
  it.each([
    ["日付: 末尾", () => parseStatementDate(`2026/11/01${NUL}`), "日付"],
    ["日付: 途中", () => parseStatementDate(`2026/11${NUL}/01`), "日付"],
    ["日付: NUL だけ", () => parseStatementDate(NUL), "日付"],
    ["金額: 末尾", () => parseYen(`100${NUL}`), "金額"],
    ["金額: 途中", () => parseYen(`1${NUL}00`), "金額"],
    ["金額: 0 の後", () => parseYen(`0${NUL}`), "金額"],
    ["金額: NUL だけ", () => parseYen(NUL), "金額"],
  ])("%s", (_label, run, field) => {
    const message = messageOf(run);
    expect(message).toContain("NUL");
    expect(message).toContain(field);
    expect(hasNul(message)).toBe(false);
  });

  it("NUL がなければ従来どおり（有効な値・返金・空欄・NUL のない不正値のエラー文言）", () => {
    expect(parseStatementDate("2026/11/01")).toBe("2026-11-01");
    expect(parseStatementDate("2026年11月1日")).toBe("2026-11-01");
    expect(parseYen("1,234")).toBe(1234);
    expect(parseYen("△500")).toBe(-500);
    expect(parseYen("(500)")).toBe(-500);
    expect(parseYen("0")).toBe(0);
    expect(parseYen("")).toBeNull();
    expect(messageOf(() => parseYen("12a"))).toContain('"12a"');
    expect(messageOf(() => parseStatementDate("2026/13/01"))).toContain('"2026/13/01"');
  });
});

// 3行目だけが NUL を含む不正な行。2行目・4行目は正常な行
type Case = { label: string; format: "bank" | "card"; bad: string };
const CASES: Case[] = [
  { label: "銀行: 日付", format: "bank", bad: `2026/11/0${NUL}2,架空店B,200,,800` },
  { label: "銀行: 出金", format: "bank", bad: `2026/11/02,架空店B,200${NUL},,800` },
  { label: "銀行: 入金", format: "bank", bad: `2026/11/02,架空店B,,200${NUL},800` },
  { label: "銀行: 残高", format: "bank", bad: `2026/11/02,架空店B,200,,8${NUL}00` },
  { label: "銀行: 金額0（出金が 0 + NUL）", format: "bank", bad: `2026/11/02,架空店B,0${NUL},,800` },
  { label: "銀行: 金額0（出金が NUL だけ、入金 0）", format: "bank", bad: `2026/11/02,架空店B,${NUL},0,800` },
  { label: "銀行: 金額0（出金 0、残高に NUL）", format: "bank", bad: `2026/11/02,架空店B,0,,8${NUL}00` },
  { label: "カード: 日付", format: "card", bad: `2026/11/0${NUL}2,架空店B,500` },
  { label: "カード: 符号付き金額", format: "card", bad: `2026/11/02,架空店B,5${NUL}00` },
  { label: "カード: 返金の金額", format: "card", bad: `2026/11/02,架空店B,-500${NUL}` },
  { label: "カード: 金額0 + NUL", format: "card", bad: `2026/11/02,架空店B,0${NUL}` },
];
const csvOf = (c: Case) =>
  c.format === "bank"
    ? [BANK_HEADER, "2026/11/01,架空店A,100,,1000", c.bad, "2026/11/03,架空店C,,300,1300"].join("\n")
    : [CARD_HEADER, "2026/11/01,架空店A,980", c.bad, "2026/11/03,架空店C,-300"].join("\n");
const formatOf = (c: Case) => (c.format === "bank" ? bank : card);

describe("parseStatementCsv: 日付・金額・残高の NUL は物理行番号つきの安全なエラーにする", () => {
  it.each(CASES)("$label", (c) => {
    const result = parseStatementCsv(csvOf(c), formatOf(c));
    expect(result.errors).toHaveLength(1);
    const [error] = result.errors;
    expect(error?.line).toBe(3);
    expect(error?.message).toContain("NUL");
    expect(hasNul(error!.message)).toBe(false);
    expect(result.ignored).toEqual([]);
    expect(result.rows.map((r) => r.line)).toEqual([2, 4]);
    expect(result.sourceRowCount).toBe(3);
  });

  it("日付が有効な行と不正な行が混在しても、有効な行の値は変わらない", () => {
    const cardDateCase = CASES.find((c) => c.label === "カード: 日付");
    if (!cardDateCase) throw new Error("カード: 日付 のケースが見つからない");
    const result = parseStatementCsv(csvOf(cardDateCase), card);
    expect(result.rows.map((r) => [r.txnDate, r.direction, r.amount])).toEqual([
      ["2026-11-01", "expense", 980],
      ["2026-11-03", "income", 300],
    ]);
  });
});

describe("importStatementCsv: 診断の記録（JSONB）に NUL を渡さず、ファイル全体の失敗を返す", () => {
  const newGateway = () => {
    const importRows = vi.fn<StatementImportGateway["importRows"]>(async () => {
      throw new Error("importRows が呼ばれてはいけない");
    });
    // PostgreSQL の JSONB は U+0000 を拒否する。個々の error.message に実際の NUL があれば拒否する
    // （JSON.stringify は NUL を \u0000 の表記に直すため、その文字列では判定しない）
    const recordFailure = vi.fn<StatementImportGateway["recordFailure"]>(async (args) => {
      if (args.errors.some((e) => e.message.includes(NUL))) {
        throw new Error("unsupported Unicode escape sequence: \\u0000 cannot be converted to text");
      }
      return FAILURE_ID;
    });
    return { importRows, recordFailure };
  };

  it.each(CASES)("$label", async (c) => {
    const gateway = newGateway();
    const bytes = new TextEncoder().encode(`﻿${csvOf(c)}`);
    const result = await importStatementCsv(
      {
        customerId: CUSTOMER,
        walletId: WALLET,
        fileName: "nul-values.csv",
        formatId: c.format === "bank" ? "bank_generic" : "card_generic",
        walletKind: c.format === "bank" ? "bank_account" : "credit_card",
        bytes,
      },
      gateway,
    );
    expect(result).toMatchObject({ ok: false, failureRecordId: FAILURE_ID });
    expect(result.ok ? [] : result.errors).toEqual([{ line: 3, message: expect.stringContaining("NUL") }]);
    expect(gateway.importRows).not.toHaveBeenCalled();
    expect(gateway.recordFailure).toHaveBeenCalledTimes(1);
    expect(gateway.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRowCount: 3, errors: [{ line: 3, message: expect.stringContaining("NUL") }] }),
    );
  });
});
