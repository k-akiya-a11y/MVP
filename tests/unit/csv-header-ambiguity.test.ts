import { describe, expect, it, vi } from "vitest";
import { findStatementFormat } from "@/lib/statements/formats";
import { importStatementCsv, type StatementImportGateway } from "@/lib/statements/import";
import { parseStatementCsv } from "@/lib/statements/parse";

// 期待の記録: docs/reviews/2026-11-05-csv-header-ambiguity.md（架空の合成データだけを使う）
const WALLET = "20000000-0000-4000-8000-000000000001";
const bank = findStatementFormat("bank_generic")!;
const card = findStatementFormat("card_generic")!;

function gateway() {
  const importRows = vi.fn<StatementImportGateway["importRows"]>(async () => {
    throw new Error("importRows が呼ばれてはいけない");
  });
  const recordFailure = vi.fn<StatementImportGateway["recordFailure"]>(async () => "fail-1");
  return { importRows, recordFailure };
}

const encode = (text: string) => new TextEncoder().encode("﻿" + text);

describe("見出しの列の重複: 同じ意味の物理列が2つ以上ある見出しは行を読む前に拒否する", () => {
  it("データ消失の例: 出金と出金額が両方ある → 金額0として黙って捨てず、エラーにする", () => {
    const csv = "日付,摘要,出金,出金額,入金\n2026/11/01,架空支払,,1200,";
    const result = parseStatementCsv(csv, bank);
    expect(result.rows).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.errors).toEqual([
      { line: 1, message: expect.stringMatching(/「出金」の列が複数あります（3列目「出金」、4列目「出金額」）/) },
    ]);
    expect(result.sourceRowCount).toBe(1);
  });

  it("金額の食い違いの例: 入金と入金額で値が別の列にあり、先頭の列の値だけが使われない", () => {
    const csv = "日付,摘要,出金,入金,入金額\n2026/11/01,架空入金,,500,700";
    const result = parseStatementCsv(csv, bank);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([{ line: 1, message: expect.stringMatching(/「入金」の列が複数あります（4列目「入金」、5列目「入金額」）/) }]);
  });

  it.each([
    ["銀行: 日付", bank, "日付,取引日,摘要,出金,入金\n2026/11/01,2026/11/02,架空,100,", "日付"],
    ["銀行: 摘要", bank, "日付,摘要,内容,出金,入金\n2026/11/01,架空,別,100,", "摘要"],
    ["銀行: 出金", bank, "日付,摘要,出金,支払金額,入金\n2026/11/01,架空,100,,", "出金"],
    ["銀行: 入金", bank, "日付,摘要,出金,入金,預入額\n2026/11/01,架空,,100,", "入金"],
    ["銀行: 残高", bank, "日付,摘要,出金,入金,残高,差引残高\n2026/11/01,架空,100,,900,900", "残高"],
    ["カード: 日付", card, "利用日,日付,利用店名,利用金額\n2026/11/01,2026/11/01,架空店,100", "日付"],
    ["カード: 摘要", card, "利用日,利用店名,摘要,利用金額\n2026/11/01,架空店,別,100", "摘要"],
    ["カード: 符号付き金額", card, "利用日,利用店名,利用金額,金額\n2026/11/01,架空店,100,200", "金額"],
    ["カード: 符号付き金額（ご利用金額）", card, "利用日,利用店名,ご利用金額,利用金額\n2026/11/01,架空店,100,200", "金額"],
  ])("%s の重複を見出し行で拒否する", (_name, format, csv, label) => {
    const result = parseStatementCsv(csv, format);
    expect(result.rows).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({ line: 1, message: expect.stringContaining(`「${label}」の列が複数あります`) });
  });

  it("同じ別名が2列ある（出金,出金）も、別の物理列なので曖昧", () => {
    const result = parseStatementCsv("日付,摘要,出金,出金,入金\n2026/11/01,架空,100,200,", bank);
    expect(result.errors).toEqual([{ line: 1, message: expect.stringContaining("「出金」の列が複数あります（3列目「出金」、4列目「出金」）") }]);
  });

  it("NFKC・空白の正規化後に同じ・別名になる見出しも重複として検出する", () => {
    const csv = "日　付,摘要,出 金,出金,入金\n2026/11/01,架空,100,200,";
    const result = parseStatementCsv(csv, bank);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([{ line: 1, message: expect.stringContaining("「出金」の列が複数あります（3列目「出 金」、4列目「出金」）") }]);
    const fullwidth = parseStatementCsv("日付,摘要,出金額,出金額,入金\n2026/11/01,架空,100,,", bank);
    expect(fullwidth.errors).toHaveLength(1);
    const wide = parseStatementCsv("日付,摘要,ご利用金額,金額\n2026/11/01,架空,100,200", card);
    expect(wide.errors).toHaveLength(1);
  });

  it("複数の意味が曖昧なら、意味ごとに1件ずつ同じ見出し行で報告する", () => {
    const csv = "日付,摘要,出金,出金額,入金,入金額\n2026/11/01,架空,100,,,";
    const result = parseStatementCsv(csv, bank);
    expect(result.errors.map((e) => e.line)).toEqual([1, 1]);
    expect(result.errors[0]!.message).toContain("「出金」");
    expect(result.errors[1]!.message).toContain("「入金」");
  });

  it("エラーの行番号は、見出しとして選ばれた実際の物理行（前置きの行がある場合）", () => {
    const csv = ["架空銀行 取引明細", "作成日,2026/11/05", "", "日付,摘要,出金,出金額,入金", "2026/11/01,架空支払,,1200,", "2026/11/02,架空支払2,300,,"].join("\n");
    const result = parseStatementCsv(csv, bank);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([{ line: 4, message: expect.stringContaining("「出金」の列が複数あります") }]);
    expect(result.sourceRowCount).toBe(2);
  });

  it("前置きにクオート内改行があっても、見出し行の開始物理行で報告する", () => {
    const csv = ['"架空銀行\n取引明細"', "日付,摘要,出金,出金額,入金", "2026/11/01,架空支払,,1200,"].join("\n");
    const result = parseStatementCsv(csv, bank);
    expect(result.errors).toEqual([{ line: 3, message: expect.stringContaining("「出金」") }]);
  });

  it("金額列が曖昧なときは「金額の列が見つかりません」ではなく曖昧の理由を返す", () => {
    const result = parseStatementCsv("利用日,利用店名,利用金額,金額\n2026/11/01,架空店,100,", card);
    expect(result.errors.map((e) => e.message).join()).not.toContain("見つかりません");
  });

  it("曖昧な見出しの後に、読めない行があっても行の解釈には進まない（見出しのエラーだけ）", () => {
    const csv = "日付,摘要,出金,出金額,入金\n不明な日付,,abc,,\n2026/11/01,架空支払,,1200,";
    const result = parseStatementCsv(csv, bank);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(1);
    expect(result.sourceRowCount).toBe(2);
  });
});

describe("見出しの列の重複: 曖昧でない見出しは従来どおり読める", () => {
  it("別名を1列ずつ使う（取引日・お取引内容・お支払金額・お預り金額・差引残高）", () => {
    const csv = "取引日,お取引内容,お支払金額,お預り金額,差引残高\n2026/11/01,架空支払,\"1,200\",,\"8,800\"\n2026/11/02,架空入金,,500,\"9,300\"";
    const result = parseStatementCsv(csv, bank);
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => [r.line, r.direction, r.amount, r.balance])).toEqual([
      [2, "expense", 1200, 8800],
      [3, "income", 500, 9300],
    ]);
  });

  it("無関係な列や、無関係な見出しの重複（備考,備考）は無視される", () => {
    const csv = "日付,摘要,出金額,入金額,備考,備考\n2026/11/01,架空支払,1200,,a,b";
    const result = parseStatementCsv(csv, bank);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ amount: 1200, direction: "expense" });
  });

  it("出金・入金・残高を持たない見出し（カードの利用金額だけ）でも、任意の列は要求しない", () => {
    const result = parseStatementCsv("ご利用日,ご利用店名,ご利用金額\n2026/11/01,架空店,980", card);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    const ok = parseStatementCsv("利用日,ご利用店名,ご利用金額,メモ\n2026/11/01,架空店,980,x", card);
    expect(ok.errors).toEqual([]);
    expect(ok.rows).toHaveLength(1);
  });

  it("前置きの行に別名が1つだけあっても、見出し行（先頭10行以内）の探索は従来どおり", () => {
    const csv = ["架空銀行", "日付,摘要,出金,入金", "2026/11/01,架空支払,100,"].join("\n");
    const result = parseStatementCsv(csv, bank);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.line).toBe(3);
  });

  it("既存の規則は維持: 金額0の行は ignored、金額の列がなければ従来のエラー", () => {
    const zero = parseStatementCsv("日付,摘要,出金,入金\n2026/11/01,残高照会,,", bank);
    expect(zero.errors).toEqual([]);
    expect(zero.ignored).toEqual([{ line: 2, reason: "金額が0（残高照会などの行）" }]);
    const noAmount = parseStatementCsv("日付,摘要,備考\n2026/11/01,架空,x", bank);
    expect(noAmount.errors).toEqual([{ line: 1, message: "金額の列が見つかりません" }]);
  });
});

describe("importStatementCsv: 曖昧な見出しはファイル全体の失敗", () => {
  const target = (text: string) => ({
    customerId: "customer-1",
    walletId: WALLET,
    fileName: "ambiguous.csv",
    formatId: "bank_generic",
    walletKind: "bank_account" as const,
    bytes: encode(text),
  });

  it("importRows を呼ばず、recordFailure に見出し行の行番号・理由・件数を渡す", async () => {
    const g = gateway();
    const csv = ["日付,摘要,出金,出金額,入金", "2026/11/01,架空支払,,1200,", "2026/11/02,別の支払,300,,"].join("\n");
    const result = await importStatementCsv(target(csv), g);
    expect(result).toMatchObject({ ok: false, failureRecordId: "fail-1" });
    expect(g.importRows).not.toHaveBeenCalled();
    expect(g.recordFailure).toHaveBeenCalledTimes(1);
    expect(g.recordFailure).toHaveBeenCalledWith({
      customerId: "customer-1",
      walletId: WALLET,
      fileName: "ambiguous.csv",
      formatId: "bank_generic",
      sourceRowCount: 2,
      errors: [{ line: 1, message: expect.stringContaining("「出金」の列が複数あります") }],
    });
  });

  it("曖昧でない同じ内容のファイルは取り込める（比較）", async () => {
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
    const csv = ["日付,摘要,出金額,入金", "2026/11/01,架空支払,1200,"].join("\n");
    const result = await importStatementCsv(target(csv), { importRows, recordFailure });
    expect(result).toMatchObject({ ok: true, insertedCount: 1 });
    expect(recordFailure).not.toHaveBeenCalled();
    expect(importRows.mock.calls[0]![0].rows.map((r) => [r.amount, r.direction])).toEqual([[1200, "expense"]]);
  });

  it("カードの金額列の重複も同様に全体失敗", async () => {
    const g = gateway();
    const result = await importStatementCsv(
      { ...target("利用日,利用店名,利用金額,金額\n2026/11/01,架空店,100,200"), formatId: "card_generic", walletKind: "credit_card" },
      g,
    );
    expect(result).toMatchObject({ ok: false });
    expect(g.importRows).not.toHaveBeenCalled();
    expect(g.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ formatId: "card_generic", sourceRowCount: 1, errors: [{ line: 1, message: expect.stringContaining("「金額」の列が複数あります") }] }),
    );
  });
});
