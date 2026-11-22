import { describe, expect, it, vi } from "vitest";
import { importStatementCsv, type StatementImportGateway } from "@/lib/statements/import";

// 期待の記録: docs/reviews/2026-11-06-import-aggregate-limit.md（架空の合成データだけを使う）
const CUSTOMER = "10000000-0000-4000-8000-000000000001";
const WALLET = "20000000-0000-4000-8000-000000000002";
const FAILURE_ID = "30000000-0000-4000-8000-000000000003";
const IMPORT_ID = "40000000-0000-4000-8000-000000000004";

// Number.MAX_SAFE_INTEGER。文字列で書き、テスト側でも丸めのある足し算をしない
const M = "9007199254740991";
const M_MINUS_1 = "9007199254740990";
const M_PLUS_1 = "9007199254740992";
const HALF = "5000000000000000"; // 個別には安全、2つ足すと 1e16 で安全でない

const BANK_HEADER = "日付,摘要,出金,入金,残高";
const CARD_HEADER = "利用日,利用店名,利用金額";

type Kind = "bank" | "card";

/** 銀行: 出金 */
const out = (day: number, amount: string) => `2026/11/${String(day).padStart(2, "0")},架空店${day},${amount},,`;
/** 銀行: 入金 */
const inn = (day: number, amount: string) => `2026/11/${String(day).padStart(2, "0")},架空入金${day},,${amount},`;
/** カード: 符号付き金額（負 = 返金） */
const cardRow = (day: number, amount: string) => `2026/11/${String(day).padStart(2, "0")},架空店${day},${amount}`;

const newGateway = () => {
  // 受け付けた場合の成功応答は、方向ごとの正確な BigInt の合計から作る（受け付ける例の合計は安全な整数以下なので Number に戻せる）
  const importRows = vi.fn<StatementImportGateway["importRows"]>(async (args) => {
    const sum = (direction: "income" | "expense") =>
      args.rows.filter((r) => r.direction === direction).reduce((acc, r) => acc + BigInt(r.amount), 0n);
    const income = sum("income");
    const expense = sum("expense");
    return {
      importId: IMPORT_ID,
      insertedCount: args.rows.length,
      skippedDuplicateCount: 0,
      suspectedDuplicateCount: 0,
      incomeTotal: Number(income),
      expenseTotal: Number(expense),
      insertedAmountTotal: Number(income + expense),
      skippedAmountTotal: 0,
      suspectedAmountTotal: 0,
    };
  });
  const recordFailure = vi.fn<StatementImportGateway["recordFailure"]>(async () => FAILURE_ID);
  return { importRows, recordFailure };
};

const run = (kind: Kind, lines: string[], gateway: StatementImportGateway) =>
  importStatementCsv(
    {
      customerId: CUSTOMER,
      walletId: WALLET,
      fileName: "aggregate-limit.csv",
      formatId: kind === "bank" ? "bank_generic" : "card_generic",
      walletKind: kind === "bank" ? "bank_account" : "credit_card",
      // BOM 付き UTF-8 の合成データ
      bytes: new TextEncoder().encode(`﻿${[kind === "bank" ? BANK_HEADER : CARD_HEADER, ...lines].join("\n")}`),
    },
    gateway,
  );

/** 合計が安全な整数を超えたので、1件も登録せず、超えた行（物理行番号）の1件のエラーを失敗として記録する */
async function expectRejected(kind: Kind, lines: string[], crossingLine: number, sourceRowCount: number) {
  const gateway = newGateway();
  const result = await run(kind, lines, gateway);
  expect(result).toMatchObject({ ok: false, failureRecordId: FAILURE_ID });
  const errors = result.ok ? [] : result.errors;
  expect(errors).toEqual([{ line: crossingLine, message: expect.stringContaining("合計") }]);
  expect(errors[0]?.message.includes("\u0000")).toBe(false);
  expect(gateway.importRows).not.toHaveBeenCalled();
  expect(gateway.recordFailure).toHaveBeenCalledTimes(1);
  expect(gateway.recordFailure).toHaveBeenCalledWith(
    expect.objectContaining({
      customerId: CUSTOMER,
      walletId: WALLET,
      sourceRowCount,
      errors: [{ line: crossingLine, message: expect.stringContaining("合計") }],
    }),
  );
}

/** 受け付ける: 全行を1回の importRows に渡し、失敗は記録しない */
async function expectAccepted(kind: Kind, lines: string[], amounts: number[], ignoredCount = 0) {
  const gateway = newGateway();
  const result = await run(kind, lines, gateway);
  expect(result).toMatchObject({ ok: true, importId: IMPORT_ID, ignoredCount });
  expect(gateway.importRows).toHaveBeenCalledTimes(1);
  expect(gateway.importRows.mock.calls[0]![0].rows.map((r) => r.amount)).toEqual(amounts);
  expect(gateway.recordFailure).not.toHaveBeenCalled();
}

describe("importStatementCsv: 1行ごとは安全でも、合計が安全な整数を超えるファイルは登録前に拒否する", () => {
  it("銀行: 出金 M と出金 1（行3で超える）", async () => {
    await expectRejected("bank", [out(1, M), out(2, "1")], 3, 2);
  });

  it("カード: 利用 M と利用 1（行3で超える）", async () => {
    await expectRejected("card", [cardRow(1, M), cardRow(2, "1")], 3, 2);
  });

  it("銀行: 出金と入金が個別には安全でも、絶対値の合計が安全でない（行3で超える）", async () => {
    await expectRejected("bank", [out(1, HALF), inn(2, HALF)], 3, 2);
  });

  it("銀行: 入金だけ（出金なし）でも合計が安全でなければ拒否する", async () => {
    await expectRejected("bank", [inn(1, M), inn(2, "1")], 3, 2);
  });

  it("カード: 利用と返金が個別には安全でも、絶対値の合計が安全でない（行3で超える）", async () => {
    await expectRejected("card", [cardRow(1, M), cardRow(2, "-1")], 3, 2);
  });

  it("カード: 2行の合計が 2^53 ちょうど（上限を 1 だけ超える）", async () => {
    await expectRejected("card", [cardRow(1, "4503599627370496"), cardRow(2, "4503599627370496")], 3, 2);
  });

  it("超えた行より後に行が続いても、超えた最初の行を報告し、sourceRowCount は全行を数える", async () => {
    await expectRejected("bank", [out(1, M), out(2, "1"), out(3, "100")], 3, 3);
  });

  it("金額 0 の行は合計に入れず、その後で超えた行の物理行番号を報告する", async () => {
    // 行2: M-1、行3: 金額 0（ignored）、行4: 2 で超える。sourceRowCount は ignored を含めて 3
    await expectRejected("bank", [out(1, M_MINUS_1), out(2, "0"), out(3, "2")], 4, 3);
  });

  it("空行を挟んでも、超えた行の物理行番号を報告する", async () => {
    // 行2: M-1、行3: 空行、行4: 2 で超える。空行は件数に数えない
    await expectRejected("bank", [out(1, M_MINUS_1), "", out(2, "2")], 4, 2);
  });
});

describe("importStatementCsv: 合計が安全な整数に収まるファイルは従来どおり受け付ける", () => {
  it("銀行: 合計がちょうど Number.MAX_SAFE_INTEGER（M-1 と 1）", async () => {
    await expectAccepted("bank", [out(1, M_MINUS_1), out(2, "1")], [9007199254740990, 1]);
  });

  it("銀行: 入金と出金の絶対値の合計がちょうど上限", async () => {
    await expectAccepted("bank", [out(1, M_MINUS_1), inn(2, "1")], [9007199254740990, 1]);
  });

  it("カード: 利用 M-1 と返金 -1 で合計がちょうど上限", async () => {
    await expectAccepted("card", [cardRow(1, M_MINUS_1), cardRow(2, "-1")], [9007199254740990, 1]);
  });

  it("1行だけで M（上限そのもの）", async () => {
    await expectAccepted("bank", [out(1, M)], [9007199254740991]);
  });

  it("通常の銀行・カード（返金を含む）", async () => {
    await expectAccepted("bank", [out(1, "1000"), inn(2, "300")], [1000, 300]);
    await expectAccepted("card", [cardRow(1, "980"), cardRow(2, "-300")], [980, 300]);
  });

  it("金額 0 の行は無視され、合計に入らない（M-1 + 0 + 1 は受け付ける）", async () => {
    await expectAccepted("bank", [out(1, M_MINUS_1), out(2, "0"), out(3, "1")], [9007199254740990, 1], 1);
  });
});

describe("importStatementCsv: 既存のパース失敗は変えず、合計のエラーを混ぜない", () => {
  it("1行だけで安全な整数を超える金額は、従来どおり行2の金額エラー", async () => {
    const gateway = newGateway();
    const result = await run("bank", [out(1, M_PLUS_1)], gateway);
    expect(result).toMatchObject({ ok: false, failureRecordId: FAILURE_ID });
    expect(result.ok ? [] : result.errors).toEqual([{ line: 2, message: expect.stringContaining("大きすぎ") }]);
    expect(gateway.importRows).not.toHaveBeenCalled();
    expect(gateway.recordFailure).toHaveBeenCalledTimes(1);
  });

  it("日付の誤りと巨大な合計が重なっても、報告するのは日付のエラーだけ", async () => {
    const gateway = newGateway();
    const bad = `2026/13/01,架空店X,${M},,`;
    const result = await run("bank", [out(1, M), bad, out(3, M)], gateway);
    expect(result).toMatchObject({ ok: false, failureRecordId: FAILURE_ID });
    const errors = result.ok ? [] : result.errors;
    expect(errors).toEqual([{ line: 3, message: expect.stringContaining("2026/13/01") }]);
    expect(errors.some((e) => e.message.includes("合計"))).toBe(false);
    expect(gateway.importRows).not.toHaveBeenCalled();
    expect(gateway.recordFailure).toHaveBeenCalledTimes(1);
    expect(gateway.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ sourceRowCount: 3, errors }));
  });

  it("カード: 金額が空欄の行と巨大な合計が重なっても、報告するのは空欄のエラーだけ", async () => {
    const gateway = newGateway();
    const result = await run("card", [cardRow(1, M), cardRow(2, ""), cardRow(3, M)], gateway);
    expect(result).toMatchObject({ ok: false, failureRecordId: FAILURE_ID });
    const errors = result.ok ? [] : result.errors;
    expect(errors).toEqual([{ line: 3, message: expect.stringContaining("空欄") }]);
    expect(gateway.importRows).not.toHaveBeenCalled();
    expect(gateway.recordFailure).toHaveBeenCalledTimes(1);
  });
});
