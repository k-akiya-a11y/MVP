import { describe, expect, it } from "vitest";
import { buildJournalPrompt } from "@/lib/ai/prompt";
import { JOURNAL_PROMPT_VERSION } from "@/lib/ai/version";
import { searchPastEntries } from "@/lib/retrieval/search";
import type { PastEntry } from "@/lib/proposals/types";
import { sampleContext, txn } from "../fixtures/proposal-context";

/** user メッセージの本文（過去仕訳の代表例が入る側）を取り出す */
function userText(past: ReturnType<typeof searchPastEntries>): string {
  const ctx = sampleContext();
  const content = buildJournalPrompt({ ...ctx, txn: txn(), walletName: "サンプル銀行", past }).messages[0]!.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

function rentEntry(i: number, overrides: Partial<PastEntry["entry"]> = {}): PastEntry {
  return {
    id: `rent-${i}`,
    entryDate: `2026-0${1 + i}-01`,
    amount: 165000,
    direction: "expense",
    bankDescription: "ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ",
    partnerKey: "サンプルフドウサン",
    entry: { accountItemId: 105, taxCode: 21, partnerId: 302, itemId: null, sectionId: 401, tagIds: [], description: `${1 + i}月分 家賃`, ...overrides },
  };
}

describe("過去仕訳の代表例に入れる項目", () => {
  it("品目とメモタグがある過去仕訳は、その ID を代表例の行に入れる", () => {
    const past = searchPastEntries(txn(), [rentEntry(0, { itemId: 601, tagIds: [501] }), rentEntry(1, { itemId: 601, tagIds: [501, 502] })]);
    const text = userText(past);
    expect(text).toContain("／品目 601／部門 401／メモタグ 501／摘要「1月分 家賃」");
    expect(text).toContain("／品目 601／部門 401／メモタグ 501、502／摘要「2月分 家賃」");
  });

  it("品目とメモタグがない過去仕訳は「なし」と明示する（AI が勝手に付けないように）", () => {
    const past = searchPastEntries(txn(), [rentEntry(0)]);
    const text = userText(past);
    expect(text).toContain("／取引先 302／品目 なし／部門 401／メモタグ なし／摘要「1月分 家賃」");
  });

  it("ある例とない例が混ざっていても、それぞれの行にそのまま出る", () => {
    const past = searchPastEntries(txn(), [rentEntry(0), rentEntry(1, { tagIds: [501] })]);
    const text = userText(past);
    expect(text).toContain("メモタグ なし／摘要「1月分 家賃」");
    expect(text).toContain("メモタグ 501／摘要「2月分 家賃」");
    // 指示にも、代表例に合わせることが書いてある
    const system = buildJournalPrompt({ ...sampleContext(), txn: txn(), walletName: "サンプル銀行", past }).system[0]!.text;
    expect(system).toContain("品目・メモタグも代表例に合わせ");
  });

  it("プロンプトの版は、この変更に合わせて更新されている", () => {
    expect(JOURNAL_PROMPT_VERSION).toBe("journal-proposal/2026-10-22.1");
  });
});
