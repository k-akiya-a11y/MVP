import { describe, expect, it, vi } from "vitest";
import { findStatementFormat } from "@/lib/statements/formats";
import { importStatementCsv, type StatementImportGateway } from "@/lib/statements/import";
import { parseStatementCsv } from "@/lib/statements/parse";

// 期待の記録: docs/reviews/2026-11-05-csv-nul-description.md（架空の合成データだけを使う）
const CUSTOMER = "10000000-0000-4000-8000-000000000001";
const WALLET = "20000000-0000-4000-8000-000000000002";
const card = findStatementFormat("card_generic")!;
const bank = findStatementFormat("bank_generic")!;

const NUL = "\u0000";
const BANK_HEADER = "日付,摘要,出金,入金";
const CARD_HEADER = "利用日,利用店名,利用金額";

const nulError = { message: expect.stringContaining("NUL") };

describe("銀行形式: 摘要の NUL は物理行番号つきのエラーにする", () => {
  it("先頭・末尾の NUL は、隣の正常な行を残したままエラーになる（値は書き換えない）", () => {
    const csv = [
      BANK_HEADER,
      "2026/11/01,架空店A,100,",
      `2026/11/02,${NUL}架空店B,200,`,
      `2026/11/03,架空店C${NUL},,300`,
      "2026/11/04,架空店D,400,",
    ].join("\n");
    const result = parseStatementCsv(csv, bank);
    expect(result.errors).toEqual([
      { line: 3, ...nulError },
      { line: 4, ...nulError },
    ]);
    expect(result.ignored).toEqual([]);
    expect(result.rows.map((r) => [r.line, r.description])).toEqual([
      [2, "架空店A"],
      [5, "架空店D"],
    ]);
    expect(result.sourceRowCount).toBe(4);
  });

  it.each([
    ["先頭", `${NUL}架空店`],
    ["末尾", `架空店${NUL}`],
    ["途中", `架空${NUL}店`],
    ["NUL だけ", NUL],
  ])("%s の NUL: 出金でも入金でもエラー。rows にも ignored にも入れない", (_label, description) => {
    const csv = [BANK_HEADER, `2026/11/01,${description},100,`, `2026/11/02,${description},,200`].join("\n");
    const result = parseStatementCsv(csv, bank);
    expect(result.errors).toEqual([
      { line: 2, ...nulError },
      { line: 3, ...nulError },
    ]);
    expect(result.rows).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.sourceRowCount).toBe(2);
  });

  it("クオート内の改行をまたぐ摘要の NUL は、行の開始の物理行番号で報告する", () => {
    const csv = [BANK_HEADER, "2026/11/01,架空店A,100,", `2026/11/02,"架空\n店${NUL}B",200,`, "2026/11/03,架空店C,300,"].join("\n");
    const result = parseStatementCsv(csv, bank);
    expect(result.errors).toEqual([{ line: 3, ...nulError }]);
    expect(result.ignored).toEqual([]);
    expect(result.rows.map((r) => r.line)).toEqual([2, 5]);
    expect(result.sourceRowCount).toBe(3);
  });

  it("金額0（出金・入金が両方空欄、または0）でも ignored にせずエラーにする", () => {
    const csv = [BANK_HEADER, "2026/11/01,架空店A,100,", `2026/11/02,残高${NUL}照会,,`, `2026/11/03,${NUL},0,0`, "2026/11/04,残高照会,,"].join("\n");
    const result = parseStatementCsv(csv, bank);
    expect(result.errors).toEqual([
      { line: 3, ...nulError },
      { line: 4, ...nulError },
    ]);
    expect(result.ignored).toEqual([{ line: 5, reason: expect.stringContaining("金額が0") }]);
    expect(result.rows.map((r) => r.line)).toEqual([2]);
    expect(result.sourceRowCount).toBe(4);
  });
});

describe("カード形式: 摘要の NUL は物理行番号つきのエラーにする", () => {
  it("先頭・末尾の NUL は、隣の正常な行を残したままエラーになる（値は書き換えない）", () => {
    const csv = [
      CARD_HEADER,
      "2026/11/01,架空店A,980",
      `2026/11/02,${NUL}架空店B,500`,
      `2026/11/03,架空店C${NUL},-300`,
      "2026/11/04,架空店D,120",
    ].join("\n");
    const result = parseStatementCsv(csv, card);
    expect(result.errors).toEqual([
      { line: 3, ...nulError },
      { line: 4, ...nulError },
    ]);
    expect(result.ignored).toEqual([]);
    expect(result.rows.map((r) => [r.line, r.direction, r.amount, r.description])).toEqual([
      [2, "expense", 980, "架空店A"],
      [5, "expense", 120, "架空店D"],
    ]);
    expect(result.sourceRowCount).toBe(4);
  });

  it.each([
    ["先頭", `${NUL}架空店`],
    ["末尾", `架空店${NUL}`],
    ["途中", `架空${NUL}店`],
    ["NUL だけ", NUL],
  ])("%s の NUL: エラー。rows にも ignored にも入れない", (_label, description) => {
    const result = parseStatementCsv(`${CARD_HEADER}\n2026/11/01,${description},980`, card);
    expect(result.errors).toEqual([{ line: 2, ...nulError }]);
    expect(result.rows).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.sourceRowCount).toBe(1);
  });

  it("前置きの行・空行・クオート内の改行があっても、複数行にまたがる行は開始の物理行番号", () => {
    const csv = ["架空カード 利用明細", "", CARD_HEADER, '"2026/11/01","架空店\nA",980', `2026/11/02,"架空\n店${NUL}B",500`, "2026/11/03,架空店C,300"].join("\n");
    const result = parseStatementCsv(csv, card);
    expect(result.errors).toEqual([{ line: 6, ...nulError }]);
    expect(result.ignored).toEqual([]);
    expect(result.rows.map((r) => r.line)).toEqual([4, 8]);
    expect(result.sourceRowCount).toBe(3);
  });

  it.each([
    ["0", "0"],
    ["全角の０", "０"],
  ])("金額%sでも ignored にせずエラーにする（読めない元データを黙って消さない）", (_label, amount) => {
    const csv = [CARD_HEADER, "2026/11/01,架空店A,980", `2026/11/02,架空${NUL}店B,${amount}`, `2026/11/03,架空店C,${amount}`].join("\n");
    const result = parseStatementCsv(csv, card);
    expect(result.errors).toEqual([{ line: 3, ...nulError }]);
    expect(result.ignored).toEqual([{ line: 4, reason: expect.stringContaining("金額が0") }]);
    expect(result.rows.map((r) => r.line)).toEqual([2]);
    expect(result.sourceRowCount).toBe(3);
  });
});

describe("通常の摘要は従来どおり（摘要は一文字も変わらない）", () => {
  const DESCRIPTIONS = ["振込 カ）ユイノヤシロ", "$1 $& $$ $' $`", "架空\n店（改行）", "架空\t店（タブ）"];
  const quoted = (d: string) => `"${d.replace(/"/g, '""')}"`;

  it("銀行: 日本語・ドル記号の並び・クオート内の改行・タブはそのまま rows に入る", () => {
    const csv = [BANK_HEADER, ...DESCRIPTIONS.map((d, i) => `2026/11/0${i + 1},${quoted(d)},${(i + 1) * 100},`)].join("\n");
    const result = parseStatementCsv(csv, bank);
    expect(result.errors).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.rows.map((r) => r.description)).toEqual(DESCRIPTIONS);
  });

  it("カード: 日本語・ドル記号の並び・クオート内の改行・タブはそのまま rows に入る", () => {
    const csv = [CARD_HEADER, ...DESCRIPTIONS.map((d, i) => `2026/11/0${i + 1},${quoted(d)},${(i + 1) * 100}`)].join("\n");
    const result = parseStatementCsv(csv, card);
    expect(result.errors).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.rows.map((r) => r.description)).toEqual(DESCRIPTIONS);
  });

  it("NUL のない金額0の行は従来どおり ignored（エラーにしない）", () => {
    const cardResult = parseStatementCsv(`${CARD_HEADER}\n2026/11/01,架空店A,0`, card);
    expect(cardResult.errors).toEqual([]);
    expect(cardResult.ignored).toEqual([{ line: 2, reason: expect.stringContaining("金額が0") }]);
    const bankResult = parseStatementCsv(`${BANK_HEADER}\n2026/11/01,残高照会,,`, bank);
    expect(bankResult.errors).toEqual([]);
    expect(bankResult.ignored).toEqual([{ line: 2, reason: expect.stringContaining("金額が0") }]);
  });
});

describe("importStatementCsv: 摘要の NUL はファイル全体の失敗（importRows を呼ばない）", () => {
  const target = (formatId: string, walletKind: "bank_account" | "credit_card", text: string) => ({
    customerId: CUSTOMER,
    walletId: WALLET,
    fileName: "nul-description.csv",
    formatId,
    walletKind,
    bytes: new TextEncoder().encode(`﻿${text}`),
  });
  const newGateway = () => {
    const importRows = vi.fn<StatementImportGateway["importRows"]>(async () => {
      throw new Error("importRows が呼ばれてはいけない");
    });
    const recordFailure = vi.fn<StatementImportGateway["recordFailure"]>(async () => "30000000-0000-4000-8000-000000000003");
    return { importRows, recordFailure };
  };

  it("銀行: NUL の行（先頭・末尾）があれば、recordFailure を行番号・件数つきで1回だけ呼ぶ", async () => {
    const gateway = newGateway();
    const csv = [BANK_HEADER, "2026/11/01,架空店A,100,", `2026/11/02,${NUL}架空店B,200,`, `2026/11/03,架空店C${NUL},,300`, "2026/11/04,架空店D,400,"].join("\n");
    const result = await importStatementCsv(target("bank_generic", "bank_account", csv), gateway);
    expect(result).toMatchObject({ ok: false, failureRecordId: "30000000-0000-4000-8000-000000000003" });
    expect(gateway.importRows).not.toHaveBeenCalled();
    expect(gateway.recordFailure).toHaveBeenCalledTimes(1);
    expect(gateway.recordFailure).toHaveBeenCalledWith({
      customerId: CUSTOMER,
      walletId: WALLET,
      fileName: "nul-description.csv",
      formatId: "bank_generic",
      sourceRowCount: 4,
      errors: [
        { line: 3, ...nulError },
        { line: 4, ...nulError },
      ],
    });
  });

  it("カード: クオート内の改行をまたぐ摘要の NUL は開始行で、recordFailure を1回だけ呼ぶ", async () => {
    const gateway = newGateway();
    const csv = [CARD_HEADER, "2026/11/01,架空店A,980", `2026/11/02,"架空\n店${NUL}B",500`, "2026/11/03,架空店C,-300"].join("\n");
    const result = await importStatementCsv(target("card_generic", "credit_card", csv), gateway);
    expect(result).toMatchObject({ ok: false });
    expect(gateway.importRows).not.toHaveBeenCalled();
    expect(gateway.recordFailure).toHaveBeenCalledTimes(1);
    expect(gateway.recordFailure).toHaveBeenCalledWith({
      customerId: CUSTOMER,
      walletId: WALLET,
      fileName: "nul-description.csv",
      formatId: "card_generic",
      sourceRowCount: 3,
      errors: [{ line: 3, ...nulError }],
    });
  });

  it("カード: 金額0の行の NUL でも、ignored に落とさずファイル全体を失敗にする", async () => {
    const gateway = newGateway();
    const csv = [CARD_HEADER, "2026/11/01,架空店A,980", `2026/11/02,架空${NUL}店B,0`].join("\n");
    const result = await importStatementCsv(target("card_generic", "credit_card", csv), gateway);
    expect(result).toMatchObject({ ok: false });
    expect(gateway.importRows).not.toHaveBeenCalled();
    expect(gateway.recordFailure).toHaveBeenCalledTimes(1);
    expect(gateway.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRowCount: 2, errors: [{ line: 3, ...nulError }] }),
    );
  });

  it("NUL のない通常のファイルは従来どおり取り込み、摘要は一文字も変わらず importRows に渡る", async () => {
    const importRows = vi.fn<StatementImportGateway["importRows"]>(async () => ({
      importId: "40000000-0000-4000-8000-000000000004",
      insertedCount: 2,
      skippedDuplicateCount: 0,
      suspectedDuplicateCount: 0,
      incomeTotal: 0,
      expenseTotal: 300,
      insertedAmountTotal: 300,
      skippedAmountTotal: 0,
      suspectedAmountTotal: 0,
    }));
    const recordFailure = vi.fn<StatementImportGateway["recordFailure"]>(async () => "unused");
    const csv = [BANK_HEADER, "2026/11/01,振込 カ）ユイノヤシロ,100,", '2026/11/02,"$1 $& $$\n架空店",200,'].join("\n");
    const result = await importStatementCsv(target("bank_generic", "bank_account", csv), { importRows, recordFailure });
    expect(result).toMatchObject({ ok: true, insertedCount: 2 });
    expect(recordFailure).not.toHaveBeenCalled();
    expect(importRows).toHaveBeenCalledTimes(1);
    expect(importRows).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRowCount: 2,
        rows: [
          expect.objectContaining({ description: "振込 カ）ユイノヤシロ" }),
          expect.objectContaining({ description: "$1 $& $$\n架空店" }),
        ],
      }),
    );
  });
});
