import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseCsv } from "@/lib/statements/csv";
import { findStatementFormat } from "@/lib/statements/formats";
import { importStatementCsv, type StatementImportGateway } from "@/lib/statements/import";
import { buildDedupeKeys, decodeStatement, parseStatementCsv } from "@/lib/statements/parse";
import { parseStatementDate, parseYen } from "@/lib/statements/values";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/statements/${name}`, import.meta.url)));
const WALLET = "20000000-0000-4000-8000-000000000001";

describe("parseCsv", () => {
  it("クオート内のカンマ・改行・二重クオートを扱う", () => {
    expect(parseCsv('a,"b,c","d\r\ne","f""g"\r\n\r\n1,2,3,4')).toEqual([
      ["a", "b,c", "d\r\ne", 'f"g'],
      ["1", "2", "3", "4"],
    ]);
  });
});

describe("parseYen", () => {
  it.each([
    ["1,234", 1234],
    ["￥1,234", 1234],
    ["¥ 1,234円", 1234],
    ["-500", -500],
    ["△500", -500],
    ["(500)", -500],
    ["１２３", 123],
    ["", null],
  ])("%s → %s", (raw, expected) => {
    expect(parseYen(raw)).toBe(expected);
  });

  it("小数は受け付けない", () => {
    expect(() => parseYen("100.5")).toThrow(/整数/);
  });
});

describe("parseStatementDate", () => {
  it.each([
    ["2026/10/01", "2026-10-01"],
    ["2026-1-5", "2026-01-05"],
    ["20261031", "2026-10-31"],
    ["2026年10月1日", "2026-10-01"],
  ])("%s → %s", (raw, expected) => {
    expect(parseStatementDate(raw)).toBe(expected);
  });

  it("存在しない日付は誤り", () => {
    expect(() => parseStatementDate("2026/02/30")).toThrow(/存在しない/);
  });
});

describe("parseStatementCsv", () => {
  it("Shift_JIS の銀行明細を読む（見出し前の行は読み飛ばす）", () => {
    const format = findStatementFormat("bank_generic")!;
    const result = parseStatementCsv(decodeStatement(fixture("bank_generic_sjis.csv"), format.encoding), format);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(5);
    expect(result.rows[0]).toEqual({
      line: 4,
      txnDate: "2026-10-01",
      amount: 165000,
      direction: "expense",
      description: "ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ",
      balance: 1835000,
    });
    expect(result.rows[4]).toMatchObject({ amount: 330000, direction: "income" });
  });

  it("UTF-8（BOM 付き）のカード明細を読み、マイナスは返金（入金）にする", () => {
    const format = findStatementFormat("card_generic")!;
    const result = parseStatementCsv(decodeStatement(fixture("card_generic_utf8bom.csv"), format.encoding), format);
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => [r.amount, r.direction])).toEqual([
      [3980, "expense"],
      [1200, "expense"],
      [3980, "income"],
    ]);
  });

  it("読めない行は行番号つきで返す", () => {
    const format = findStatementFormat("bank_generic")!;
    const result = parseStatementCsv("日付,摘要,出金,入金\n2026/10/01,A,100,200\n2026/13/01,B,100,\n", format);
    expect(result.errors).toEqual([
      { line: 2, message: "出金と入金の両方に金額があります" },
      { line: 3, message: '存在しない日付です: "2026/13/01"' },
    ]);
  });

  it("見出しがなければ誤り", () => {
    const format = findStatementFormat("bank_generic")!;
    expect(parseStatementCsv("a,b,c\n1,2,3\n", format).errors[0]?.message).toMatch(/見出し行/);
  });
});

describe("buildDedupeKeys", () => {
  it("同じ取引が同じファイルに2回あれば別のキー、取り込み直しても同じキー", () => {
    const format = findStatementFormat("bank_generic")!;
    const { rows } = parseStatementCsv(decodeStatement(fixture("bank_generic_sjis.csv"), format.encoding), format);
    const keys = buildDedupeKeys(WALLET, rows);
    expect(new Set(keys).size).toBe(rows.length);
    expect(buildDedupeKeys(WALLET, rows)).toEqual(keys);
    expect(buildDedupeKeys("20000000-0000-4000-8000-000000000002", rows)).not.toEqual(keys);
  });

  it("同日・同額・同摘要でも残高が違えば別のキー（別の CSV に1件ずつ入っていても区別できる）", () => {
    const row = { line: 2, txnDate: "2026-10-05", amount: 550, direction: "expense" as const, description: "ｻﾝﾌﾟﾙｺﾝﾋﾞﾆ" };
    const [a] = buildDedupeKeys(WALLET, [{ ...row, balance: 10000 }]);
    const [b] = buildDedupeKeys(WALLET, [{ ...row, balance: 9450 }]);
    expect(a).not.toBe(b);
  });

  it("残高がなければ同じキーになる（DB 側で捨てずに「重複の疑い」に回す）", () => {
    const row = { line: 2, txnDate: "2026-10-05", amount: 550, direction: "expense" as const, description: "ｻﾝﾌﾟﾙｺﾝﾋﾞﾆ", balance: null };
    expect(buildDedupeKeys(WALLET, [row])).toEqual(buildDedupeKeys(WALLET, [{ ...row, line: 9 }]));
  });
});

describe("importStatementCsv", () => {
  const ok: StatementImportGateway = async ({ rows }) => ({
    importId: "imp-1",
    insertedCount: rows.length,
    skippedDuplicateCount: 0,
    suspectedDuplicateCount: 0,
  });

  it("読めた行を DB に渡す", async () => {
    const gateway = vi.fn(ok);
    const result = await importStatementCsv(
      { customerId: "c", walletId: WALLET, fileName: "oct.csv", formatId: "bank_generic", bytes: fixture("bank_generic_sjis.csv") },
      gateway,
    );
    expect(result).toEqual({ ok: true, importId: "imp-1", insertedCount: 5, skippedDuplicateCount: 0, suspectedDuplicateCount: 0 });
    expect(gateway.mock.calls[0]![0].rows[1]).toMatchObject({
      txn_date: "2026-10-27",
      amount: 9020,
      direction: "expense",
      description: "ｻﾝﾌﾟﾙﾂｳｼﾝ(ｶ",
    });
  });

  it("1行でも読めなければ何も登録しない", async () => {
    const gateway = vi.fn(ok);
    const bytes = new TextEncoder().encode("﻿日付,摘要,出金,入金\n2026/10/01,A,100,\n2026/10/02,B,abc,\n");
    const result = await importStatementCsv(
      { customerId: "c", walletId: WALLET, fileName: "x.csv", formatId: "bank_generic", bytes },
      gateway,
    );
    expect(result.ok).toBe(false);
    expect(gateway).not.toHaveBeenCalled();
  });

  it("想定と違う文字コードは誤り", async () => {
    const gateway = vi.fn(ok);
    const bytes = new Uint8Array([0x93, 0xfa, 0xff, 0xff]);
    const result = await importStatementCsv(
      { customerId: "c", walletId: WALLET, fileName: "x.csv", formatId: "bank_generic", bytes },
      gateway,
    );
    expect(result).toMatchObject({ ok: false });
    expect(gateway).not.toHaveBeenCalled();
  });
});
