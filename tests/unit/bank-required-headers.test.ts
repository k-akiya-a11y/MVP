import { describe, expect, it, vi } from "vitest";
import { findStatementFormat } from "@/lib/statements/formats";
import { importStatementCsv, type StatementImportGateway } from "@/lib/statements/import";
import { parseStatementCsv } from "@/lib/statements/parse";

// 期待の記録: docs/reviews/2026-11-05-bank-required-headers.md（架空の合成データだけを使う）
const WALLET = "20000000-0000-4000-8000-000000000001";
const bank = findStatementFormat("bank_generic")!;
const card = findStatementFormat("card_generic")!;

const MISSING_DEPOSIT = "日付,摘要,出金,未対応入金\n2026/11/01,架空支払,100,\n2026/11/02,架空入金,,500";
const MISSING_WITHDRAWAL = "日付,摘要,未対応出金,入金\n2026/11/01,架空支払,100,\n2026/11/02,架空入金,,500";

describe("銀行形式: 出金・入金の見出しの片方が認識できなければ、行を読む前に失敗する", () => {
  it("入金の見出しが未認識: 入金500円を0円として捨てず、見出し行のエラーにする", () => {
    const result = parseStatementCsv(MISSING_DEPOSIT, bank);
    expect(result.rows).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.errors).toEqual([{ line: 1, message: expect.stringContaining("「入金」の列が見つかりません") }]);
    expect(result.sourceRowCount).toBe(2);
  });

  it("出金の見出しが未認識（逆方向）: 出金を0円として捨てず、見出し行のエラーにする", () => {
    const result = parseStatementCsv(MISSING_WITHDRAWAL, bank);
    expect(result.rows).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.errors).toEqual([{ line: 1, message: expect.stringContaining("「出金」の列が見つかりません") }]);
    expect(result.sourceRowCount).toBe(2);
  });

  it("エラーは認識できなかった側の1件だけ（認識できた側は報告しない）", () => {
    const result = parseStatementCsv(MISSING_DEPOSIT, bank);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).not.toContain("「出金」");
  });

  it("読めない行が混ざっていても行の解釈には進まず、見出しのエラーだけを返す", () => {
    const csv = "日付,摘要,出金,未対応入金\n不明な日付,,abc,\n2026/11/02,架空入金,,500";
    const result = parseStatementCsv(csv, bank);
    expect(result.rows).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.errors).toEqual([{ line: 1, message: expect.stringContaining("「入金」の列が見つかりません") }]);
    expect(result.sourceRowCount).toBe(2);
  });

  it("前置きの行と空行があっても、エラーの行番号は見出しの物理行（4行目）", () => {
    const csv = ["架空銀行 取引明細", "作成日,2026/11/05", "", "日付,摘要,出金,未対応入金", "2026/11/01,架空支払,100,", "", "2026/11/02,架空入金,,500"].join("\n");
    const result = parseStatementCsv(csv, bank);
    expect(result.rows).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.errors).toEqual([{ line: 4, message: expect.stringContaining("「入金」の列が見つかりません") }]);
    expect(result.sourceRowCount).toBe(2);
  });

  it("全角・空白の見出しと銀行の別名は認識したうえで、足りない側だけを報告する", () => {
    const noDeposit = parseStatementCsv("日　付,摘　要,お支払金額,預り金\n2026/11/01,架空支払,100,\n2026/11/02,架空入金,,500", bank);
    expect(noDeposit.rows).toEqual([]);
    expect(noDeposit.errors).toEqual([{ line: 1, message: expect.stringContaining("「入金」の列が見つかりません") }]);
    const noWithdrawal = parseStatementCsv("日付,摘要,支払,　お預り金額　\n2026/11/01,架空支払,100,\n2026/11/02,架空入金,,500", bank);
    expect(noWithdrawal.rows).toEqual([]);
    expect(noWithdrawal.errors).toEqual([{ line: 1, message: expect.stringContaining("「出金」の列が見つかりません") }]);
  });

  it("残高の見出しがあっても、出金・入金の片方が未認識なら失敗する", () => {
    const result = parseStatementCsv("日付,摘要,出金,未対応入金,残高\n2026/11/01,架空支払,100,,900\n2026/11/02,架空入金,,500,1400", bank);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([{ line: 1, message: expect.stringContaining("「入金」の列が見つかりません") }]);
  });

  it("出金・入金の見出しが両方ない銀行形式は、従来どおり「金額の列が見つかりません」", () => {
    const result = parseStatementCsv("日付,摘要,備考\n2026/11/01,架空,x", bank);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([{ line: 1, message: "金額の列が見つかりません" }]);
    expect(result.sourceRowCount).toBe(1);
  });
});

describe("銀行形式: 出金・入金の見出しが両方あれば従来どおり読める", () => {
  it("列内の空欄は許可（出金だけ・入金だけの行）。残高の見出しがなくてもよい", () => {
    const result = parseStatementCsv("日付,摘要,出金,入金\n2026/11/01,架空支払,100,\n2026/11/02,架空入金,,500", bank);
    expect(result.errors).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.rows.map((r) => [r.line, r.direction, r.amount, r.balance])).toEqual([
      [2, "expense", 100, null],
      [3, "income", 500, null],
    ]);
    expect(result.sourceRowCount).toBe(2);
  });

  it("正常な金額0の行（両方空欄・0）は取引にせず ignored に残す", () => {
    const result = parseStatementCsv("日付,摘要,出金,入金\n2026/11/01,残高照会,,\n2026/11/02,残高確認,0,0\n2026/11/03,架空支払,100,", bank);
    expect(result.errors).toEqual([]);
    expect(result.ignored).toEqual([
      { line: 2, reason: expect.stringContaining("金額が0") },
      { line: 3, reason: expect.stringContaining("金額が0") },
    ]);
    expect(result.rows.map((r) => [r.line, r.amount])).toEqual([[4, 100]]);
    expect(result.sourceRowCount).toBe(3);
  });

  it("銀行の別名・全角の見出しは認識される（出金額・お預り金額）", () => {
    const result = parseStatementCsv("日　付,摘　要,出金額,お預り金額\n2026/11/01,架空支払,100,\n2026/11/02,架空入金,,500", bank);
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => [r.direction, r.amount])).toEqual([["expense", 100], ["income", 500]]);
  });
});

describe("カード形式: 符号付き金額の扱いは変わらない", () => {
  it("利用金額で読み、マイナスは返金（入金）。出金・入金の見出しは要求しない", () => {
    const result = parseStatementCsv("利用日,利用店名,利用金額\n2026/11/01,架空店,980\n2026/11/02,架空店返金,-300", card);
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => [r.direction, r.amount])).toEqual([["expense", 980], ["income", 300]]);
  });

  it("金額の見出しがなければ従来どおり「金額の列が見つかりません」", () => {
    const result = parseStatementCsv("利用日,利用店名,備考\n2026/11/01,架空店,x", card);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([{ line: 1, message: "金額の列が見つかりません" }]);
    expect(result.sourceRowCount).toBe(1);
  });

  it("カードの CSV に「出金」の見出しがあっても使わない（銀行の見出しで読み替えない）", () => {
    const result = parseStatementCsv("利用日,利用店名,出金\n2026/11/01,架空店,100", card);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([{ line: 1, message: "金額の列が見つかりません" }]);
  });
});

describe("importStatementCsv: 片方の見出しが未認識ならファイル全体の失敗", () => {
  const encode = (text: string) => new TextEncoder().encode("﻿" + text);
  const target = (text: string) => ({
    customerId: "customer-1",
    walletId: WALLET,
    fileName: "missing-header.csv",
    formatId: "bank_generic",
    walletKind: "bank_account" as const,
    bytes: encode(text),
  });

  it.each([
    ["入金", MISSING_DEPOSIT],
    ["出金", MISSING_WITHDRAWAL],
  ])("「%s」が未認識: importRows を呼ばず、recordFailure を1回だけ呼ぶ", async (label, csv) => {
    const importRows = vi.fn<StatementImportGateway["importRows"]>(async () => {
      throw new Error("importRows が呼ばれてはいけない");
    });
    const recordFailure = vi.fn<StatementImportGateway["recordFailure"]>(async () => "fail-1");
    const result = await importStatementCsv(target(csv), { importRows, recordFailure });
    expect(result).toMatchObject({ ok: false, failureRecordId: "fail-1" });
    expect(importRows).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith({
      customerId: "customer-1",
      walletId: WALLET,
      fileName: "missing-header.csv",
      formatId: "bank_generic",
      sourceRowCount: 2,
      errors: [{ line: 1, message: expect.stringContaining(`「${label}」の列が見つかりません`) }],
    });
  });
});
