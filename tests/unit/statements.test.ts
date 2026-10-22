import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseCsv } from "@/lib/statements/csv";
import { STATEMENT_CSV_FORMATS, findStatementFormat } from "@/lib/statements/formats";
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

  it("実結合の追加確認用の銀行明細（ルール一致の行を複数含む）を読み、最初の明細とキーが重ならない", () => {
    const format = findStatementFormat("bank_generic")!;
    const more = parseStatementCsv(decodeStatement(fixture("bank_generic_sjis_more.csv"), format.encoding), format);
    expect(more.errors).toEqual([]);
    expect(more.rows.map((r) => [r.txnDate, r.amount])).toEqual([
      ["2026-11-27", 9020],
      ["2026-12-01", 165000],
      ["2026-12-25", 9020],
      ["2026-12-26", 1100],
      ["2026-12-27", 8800],
      ["2026-12-28", 9020],
    ]);
    const first = parseStatementCsv(decodeStatement(fixture("bank_generic_sjis.csv"), format.encoding), format);
    const firstKeys = new Set(buildDedupeKeys(WALLET, first.rows));
    expect(buildDedupeKeys(WALLET, more.rows).some((k) => firstKeys.has(k))).toBe(false);
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

describe("CSV の形式と口座の種類の対応", () => {
  it("アプリの形式定義と DB の取込関数（statement_csv_format_wallet_kind）が同じ対応を持つ", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/20261022000100_import_wallet_kind_check.sql", import.meta.url), "utf8");
    const pairs = [...sql.matchAll(/when '([a-z_]+)' then '([a-z_]+)'/g)].map((m) => [m[1], m[2]]);
    expect(pairs).toEqual(STATEMENT_CSV_FORMATS.map((f) => [f.id, f.walletKind]));
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

describe("行番号", () => {
  it("空行やクオート内の改行があっても、エラーの行番号は CSV ファイル上の行と一致する", () => {
    const format = findStatementFormat("bank_generic")!;
    const text = '日付,摘要,出金,入金\n\n2026/10/01,"A\n社",100,\n\n2026/10/02,B,abc,\n2026/10/03,残高照会,0,0\n';
    const result = parseStatementCsv(text, format);
    expect(result.errors).toEqual([{ line: 6, message: expect.any(String) }]);
    expect(result.ignored).toEqual([{ line: 7, reason: expect.any(String) }]);
    expect(result.rows[0]).toMatchObject({ line: 3, description: "A\n社" });
    expect(result.sourceRowCount).toBe(3);
  });
});

describe("importStatementCsv", () => {
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

  it("読めた行と、照合用の行数・金額0の行を DB に渡す", async () => {
    const g = gateway();
    const result = await importStatementCsv(
      { customerId: "c", walletId: WALLET, fileName: "oct.csv", formatId: "bank_generic", walletKind: "bank_account", bytes: fixture("bank_generic_sjis.csv") },
      g,
    );
    expect(result).toMatchObject({ ok: true, importId: "imp-1", insertedCount: 5, ignoredCount: 0 });
    const args = g.importRows.mock.calls[0]![0];
    expect(args.sourceRowCount).toBe(5);
    expect(args.rows[1]).toMatchObject({ txn_date: "2026-10-27", amount: 9020, direction: "expense", description: "ｻﾝﾌﾟﾙﾂｳｼﾝ(ｶ" });
    expect(g.recordFailure).not.toHaveBeenCalled();
  });

  it("金額0の行は取引にせず、行番号と理由を渡す（黙って捨てない）", async () => {
    const g = gateway();
    const bytes = new TextEncoder().encode("\ufeff日付,摘要,出金,入金\n2026/10/01,A,100,\n2026/10/02,残高照会,0,0\n");
    const result = await importStatementCsv({ customerId: "c", walletId: WALLET, fileName: "x.csv", formatId: "bank_generic", walletKind: "bank_account", bytes }, g);
    expect(result).toMatchObject({ ok: true, insertedCount: 1, ignoredCount: 1 });
    const args = g.importRows.mock.calls[0]![0];
    expect(args.sourceRowCount).toBe(2);
    expect(args.ignored).toEqual([{ line: 3, reason: expect.stringContaining("金額が0") }]);
  });

  it("1行でも読めなければ明細を登録せず、失敗として理由と行番号を記録する", async () => {
    const g = gateway();
    const bytes = new TextEncoder().encode("\ufeff日付,摘要,出金,入金\n2026/10/01,A,100,\n2026/10/02,B,abc,\n");
    const result = await importStatementCsv({ customerId: "c", walletId: WALLET, fileName: "x.csv", formatId: "bank_generic", walletKind: "bank_account", bytes }, g);
    expect(result).toMatchObject({ ok: false, failureRecordId: "fail-1" });
    expect(g.importRows).not.toHaveBeenCalled();
    expect(g.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "x.csv", sourceRowCount: 2, errors: [expect.objectContaining({ line: 3 })] }),
    );
  });

  it("CSV の形式と口座の種類が合わなければ取り込まない（銀行明細をカードの口座に入れると、取込済みと判定できず二重に登録される）", async () => {
    const g = gateway();
    const result = await importStatementCsv(
      { customerId: "c", walletId: WALLET, fileName: "oct.csv", formatId: "bank_generic", walletKind: "credit_card", bytes: fixture("bank_generic_sjis.csv") },
      g,
    );
    expect(result).toMatchObject({ ok: false, failureRecordId: "fail-1", errors: [{ line: 0, message: expect.stringContaining("合っていません") }] });
    expect(g.importRows).not.toHaveBeenCalled();

    const card = gateway();
    const cardResult = await importStatementCsv(
      { customerId: "c", walletId: WALLET, fileName: "card.csv", formatId: "card_generic", walletKind: "bank_account", bytes: fixture("card_generic_utf8bom.csv") },
      card,
    );
    expect(cardResult).toMatchObject({ ok: false });
    expect(card.importRows).not.toHaveBeenCalled();
  });

  it("想定と違う文字コードも失敗として記録する", async () => {
    const g = gateway();
    const bytes = new Uint8Array([0x93, 0xfa, 0xff, 0xff]);
    const result = await importStatementCsv({ customerId: "c", walletId: WALLET, fileName: "x.csv", formatId: "bank_generic", walletKind: "bank_account", bytes }, g);
    expect(result).toMatchObject({ ok: false, failureRecordId: "fail-1" });
    expect(g.importRows).not.toHaveBeenCalled();
  });
});
