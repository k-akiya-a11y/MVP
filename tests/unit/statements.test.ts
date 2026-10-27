import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CsvSyntaxError, parseCsv, parseCsvWithLines } from "@/lib/statements/csv";
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

  it("CRLF・LF・CR の改行、末尾の改行なし、BOM、空欄のセルを正しく読む", () => {
    expect(parseCsv("a,b\r\n1,\r\n,2")).toEqual([["a", "b"], ["1", ""], ["", "2"]]);
    expect(parseCsv("a,b\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,b\r1,2\r")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("﻿a,b\n")).toEqual([["a", "b"]]);
    expect(parseCsv('a,""\n"",b')).toEqual([["a", ""], ["", "b"]]);
  });

  it("空のファイル・空行だけのファイルは0行", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\r\n\r\n")).toEqual([]);
    expect(parseCsv("﻿")).toEqual([]);
  });

  it("クオート内の CRLF・カンマ・\"\" を含む値が最後のフィールドでも読める", () => {
    expect(parseCsv('a,"x\r\ny,""z"""')).toEqual([["a", 'x\r\ny,"z"']]);
  });

  it("空行を除いても、行番号はファイル上の行（クオート内の改行を含む）のまま", () => {
    const rows = parseCsvWithLines('h\n\n"a\nb",1\r\n\r\nc,2');
    expect(rows.map((r) => r.line)).toEqual([1, 3, 6]);
  });

  describe("形式が壊れた CSV は黙って直さず CsvSyntaxError にする", () => {
    it("閉じられていないクオートは後続の行を飲み込むので誤り（開いた行を示す）", () => {
      expect(() => parseCsv('a,b\n1,"x\n2,y\n3,z\n')).toThrow(CsvSyntaxError);
      try {
        parseCsv('a,b\n1,"x\n2,y\n');
      } catch (error) {
        expect(error).toMatchObject({ name: "CsvSyntaxError", line: 2 });
      }
    });

    it("値の途中のダブルクオートは誤り", () => {
      expect(() => parseCsv('a,b"c,d')).toThrow(CsvSyntaxError);
      expect(() => parseCsv('a, "b",c')).toThrow(CsvSyntaxError);
    });

    it("閉じクオートの後ろの余分な文字は誤り（空白も）", () => {
      expect(() => parseCsv('"a"b,c')).toThrow(CsvSyntaxError);
      expect(() => parseCsv('"a" ,c')).toThrow(CsvSyntaxError);
      expect(() => parseCsv('"a"""x,c')).toThrow(CsvSyntaxError);
      expect(() => parseCsv('a,"b"x')).toThrow(CsvSyntaxError);
    });

    it("誤りの行番号は問題を見つけたファイル上の行", () => {
      try {
        parseCsv('a,b\n1,2\n3,"x"y\n');
        throw new Error("should not reach");
      } catch (error) {
        expect(error).toBeInstanceOf(CsvSyntaxError);
        expect((error as CsvSyntaxError).line).toBe(3);
      }
    });
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

  it("UTF-8 の BOM があれば、形式が Shift_JIS 指定でも UTF-8 として読む", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("日付,摘要\nサンプル商事")]);
    expect(decodeStatement(bytes, "shift_jis")).toBe("日付,摘要\nサンプル商事");
  });

  it("BOM 付き UTF-8 に不正なバイトがあれば、置き換えずに読み込みを拒否する", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("日付,摘要\nA"), 0xff, 0xfe]);
    expect(() => decodeStatement(bytes, "shift_jis")).toThrow();
    expect(() => decodeStatement(bytes, "utf-8")).toThrow();
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

  describe("壊れた CSV は行を1件も返さず、誤りを行番号つきで返す", () => {
    const bank = findStatementFormat("bank_generic")!;
    const card = findStatementFormat("card_generic")!;

    it("閉じられていないクオートが次の行を摘要に飲み込んでも、読めた行として扱わない", () => {
      const result = parseStatementCsv('日付,摘要,出金,入金\n2026/10/01,"A,100,\n2026/10/02,B,200,\n', bank);
      expect(result.rows).toEqual([]);
      expect(result.ignored).toEqual([]);
      expect(result.errors).toEqual([{ line: 2, message: expect.stringContaining("CSV の書式が正しくありません") }]);
      expect(result.sourceRowCount).toBeNull();
    });

    it("値の途中のクオート・閉じクオートの後ろの余分な文字も、ファイル全体の誤りにする", () => {
      for (const body of ['2026/10/01,A"B,100,\n', '2026/10/01,"A"B,100,\n']) {
        const result = parseStatementCsv(`日付,摘要,出金,入金\n${body}`, bank);
        expect(result.rows).toEqual([]);
        expect(result.errors).toEqual([{ line: 2, message: expect.stringContaining("CSV の書式が正しくありません") }]);
        expect(result.sourceRowCount).toBeNull();
      }
    });

    it("途中で切れた行（列が足りない）は、欠けた列を金額0として読み飛ばさず誤りにする", () => {
      const result = parseStatementCsv("日付,摘要,出金,入金\n2026/10/01,A,100,\n2026/10/02,B\n", bank);
      expect(result.errors).toEqual([{ line: 3, message: expect.stringContaining("列が足りません") }]);
      expect(result.ignored).toEqual([]);
      expect(result.rows.map((r) => r.line)).toEqual([2]);
      expect(result.sourceRowCount).toBe(2);
    });

    it("使う列のどれかが欠けた行は誤り（残高が最後の列で、その列が欠けた行も）", () => {
      const withBalance = "日付,摘要,出金,入金,残高\n";
      expect(parseStatementCsv(`${withBalance}2026/10/01,A,100,\n`, bank).errors).toEqual([{ line: 2, message: expect.stringContaining("列が足りません") }]);
      expect(parseStatementCsv("利用日,利用店名,利用金額\n2026/10/01,店A\n", card).errors).toEqual([
        { line: 2, message: expect.stringContaining("列が足りません") },
      ]);
    });

    it("クオートされていないカンマで列がずれた行は誤り（見出しより右に値がある）", () => {
      const shifted = parseStatementCsv("日付,摘要,出金,入金,残高\n2026/10/01,A,B社,100,,5000\n", bank);
      expect(shifted.rows).toEqual([]);
      expect(shifted.errors).toHaveLength(1);
      const wide = parseStatementCsv("日付,摘要,出金,入金\n2026/10/01,A,100,,extra\n", bank);
      expect(wide.errors).toEqual([{ line: 2, message: expect.stringContaining("見出しより右に値があります") }]);
    });

    it("見出しより右が空欄だけなら（行末の余分なカンマ）読める", () => {
      const result = parseStatementCsv("日付,摘要,出金,入金\n2026/10/01,A,100,,,\n", bank);
      expect(result.errors).toEqual([]);
      expect(result.rows).toHaveLength(1);
    });
  });

  describe("正しい書式は変わらず読める", () => {
    const bank = findStatementFormat("bank_generic")!;

    it("クオート内のカンマ・改行・二重クオートと、CRLF", () => {
      const text = '日付,摘要,出金,入金,残高\r\n2026/10/01,"A,B社 ""本店""",100,,900\r\n2026/10/02,"C\r\n社",,200,1100\r\n';
      const result = parseStatementCsv(text, bank);
      expect(result.errors).toEqual([]);
      expect(result.rows).toEqual([
        { line: 2, txnDate: "2026-10-01", amount: 100, direction: "expense", description: 'A,B社 "本店"', balance: 900 },
        { line: 3, txnDate: "2026-10-02", amount: 200, direction: "income", description: "C\r\n社", balance: 1100 },
      ]);
      expect(result.sourceRowCount).toBe(2);
    });

    it("出金・入金のどちらかが空欄でも読める。両方空欄なら金額0の行として理由を残す", () => {
      const result = parseStatementCsv("日付,摘要,出金,入金\n2026/10/01,A,,500\n2026/10/02,B,300,\n2026/10/03,残高,,\n", bank);
      expect(result.errors).toEqual([]);
      expect(result.rows.map((r) => [r.amount, r.direction])).toEqual([[500, "income"], [300, "expense"]]);
      expect(result.ignored).toEqual([{ line: 4, reason: expect.stringContaining("金額が0") }]);
      expect(result.sourceRowCount).toBe(3);
    });

    it("取引の行が0件でも、見出しだけのファイルとして読める（取込側で取り込まない）", () => {
      const result = parseStatementCsv("日付,摘要,出金,入金\r\n", bank);
      expect(result).toEqual({ rows: [], errors: [], ignored: [], sourceRowCount: 0 });
    });
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

  it("連番はファイルごとに数え直すので、別ファイルの別取引が同じキーになりうる（DB 側が読み飛ばさず「重複の疑い」に回す前提）", () => {
    const shop = { line: 2, txnDate: "2026-10-05", amount: 1000, direction: "expense" as const, description: "ｻﾝﾌﾟﾙｼﾖﾂﾌﾟ", balance: 9000 };
    const salary = { line: 2, txnDate: "2026-10-05", amount: 1000, direction: "income" as const, description: "ｻﾝﾌﾟﾙﾆﾕｳｷﾝ", balance: 10000 };
    const [inA] = buildDedupeKeys(WALLET, [shop]);
    const keysB = buildDedupeKeys(WALLET, [salary, { ...shop, line: 3 }]);
    expect(keysB[1]).toBe(inA);
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

  it("BOM 付き UTF-8 に不正なバイトがあれば、文字コードの失敗として記録し、DB の取込を呼ばない", async () => {
    const g = gateway();
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("日付,摘要,出金,入金\n2026/10/01,A,100,\n"), 0xff]);
    const result = await importStatementCsv({ customerId: "c", walletId: WALLET, fileName: "x.csv", formatId: "bank_generic", walletKind: "bank_account", bytes }, g);
    expect(result).toMatchObject({ ok: false, failureRecordId: "fail-1", errors: [{ line: 0, message: expect.stringContaining("文字コード") }] });
    expect(g.importRows).not.toHaveBeenCalled();
    expect(g.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ fileName: "x.csv", sourceRowCount: null }));
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

  it("閉じられていないクオートのファイルは、1件も登録せず、書式の誤りの行番号を失敗として記録する", async () => {
    const g = gateway();
    const bytes = new TextEncoder().encode('﻿日付,摘要,出金,入金\n2026/10/01,A,100,\n2026/10/02,"B,200,\n2026/10/03,C,300,\n');
    const result = await importStatementCsv({ customerId: "c", walletId: WALLET, fileName: "x.csv", formatId: "bank_generic", walletKind: "bank_account", bytes }, g);
    expect(result).toMatchObject({ ok: false, failureRecordId: "fail-1", errors: [{ line: 3, message: expect.stringContaining("書式") }] });
    expect(g.importRows).not.toHaveBeenCalled();
    expect(g.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "x.csv", sourceRowCount: null, errors: [expect.objectContaining({ line: 3 })] }),
    );
  });

  it("途中で切れた行（2026/10/02,B）があれば、ほかの行も含めて1件も登録しない", async () => {
    const g = gateway();
    const bytes = new TextEncoder().encode("﻿日付,摘要,出金,入金\n2026/10/01,A,100,\n2026/10/02,B\n2026/10/03,C,300,\n");
    const result = await importStatementCsv({ customerId: "c", walletId: WALLET, fileName: "x.csv", formatId: "bank_generic", walletKind: "bank_account", bytes }, g);
    expect(result).toMatchObject({ ok: false, errors: [{ line: 3, message: expect.stringContaining("列が足りません") }] });
    expect(g.importRows).not.toHaveBeenCalled();
    expect(g.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ sourceRowCount: 3, errors: [expect.objectContaining({ line: 3 })] }));
  });

  it("クオートの後ろの余分な文字・値の途中のクオート・幅の違う行は、どれも取り込まない", async () => {
    for (const row of ['2026/10/02,"B"x,200,', '2026/10/02,B"x,200,', "2026/10/02,B,200,,extra"]) {
      const g = gateway();
      const bytes = new TextEncoder().encode(`﻿日付,摘要,出金,入金\n2026/10/01,A,100,\n${row}\n`);
      const result = await importStatementCsv({ customerId: "c", walletId: WALLET, fileName: "x.csv", formatId: "bank_generic", walletKind: "bank_account", bytes }, g);
      expect(result, row).toMatchObject({ ok: false, failureRecordId: "fail-1" });
      expect(g.importRows, row).not.toHaveBeenCalled();
    }
  });

  it("取引の行が0件のファイルは取り込まず、失敗として記録する", async () => {
    const g = gateway();
    const bytes = new TextEncoder().encode("﻿日付,摘要,出金,入金\r\n");
    const result = await importStatementCsv({ customerId: "c", walletId: WALLET, fileName: "x.csv", formatId: "bank_generic", walletKind: "bank_account", bytes }, g);
    expect(result).toMatchObject({ ok: false, errors: [{ line: 0, message: expect.stringContaining("取引の行がありません") }] });
    expect(g.importRows).not.toHaveBeenCalled();
    expect(g.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ sourceRowCount: 0 }));
  });

  it("クオート・CRLF・空欄の入金/出金を含む正しいファイルは、そのまま取り込む", async () => {
    const g = gateway();
    const bytes = new TextEncoder().encode('﻿日付,摘要,出金,入金\r\n2026/10/01,"A,B社",100,\r\n2026/10/02,"C ""D""",,200\r\n');
    const result = await importStatementCsv({ customerId: "c", walletId: WALLET, fileName: "x.csv", formatId: "bank_generic", walletKind: "bank_account", bytes }, g);
    expect(result).toMatchObject({ ok: true, insertedCount: 2 });
    const args = g.importRows.mock.calls[0]![0];
    expect(args.rows.map((r) => [r.description, r.amount, r.direction])).toEqual([["A,B社", 100, "expense"], ['C "D"', 200, "income"]]);
    expect(g.recordFailure).not.toHaveBeenCalled();
  });

  it("想定と違う文字コードも失敗として記録する", async () => {
    const g = gateway();
    const bytes = new Uint8Array([0x93, 0xfa, 0xff, 0xff]);
    const result = await importStatementCsv({ customerId: "c", walletId: WALLET, fileName: "x.csv", formatId: "bank_generic", walletKind: "bank_account", bytes }, g);
    expect(result).toMatchObject({ ok: false, failureRecordId: "fail-1" });
    expect(g.importRows).not.toHaveBeenCalled();
  });
});
