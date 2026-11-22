import { describe, expect, it } from "vitest";
import { buildJournalPrompt } from "@/lib/ai/prompt";
import { JOURNAL_PROMPT_VERSION } from "@/lib/ai/version";
import { searchPastEntries } from "@/lib/retrieval/search";
import type { PastEntry } from "@/lib/proposals/types";
import { sampleContext, txn } from "../fixtures/proposal-context";

type SentExample = {
  entryDate: string;
  amount: number;
  bankDescription: string | null;
  entry: { accountItemId: number; taxCode: number; partnerId: number | null; itemId: number | null; sectionId: number | null; tagIds: number[]; description: string };
};

/** user メッセージ（参考データの JSON）を読み戻し、過去仕訳の代表例を取り出す */
function sentExamples(past: ReturnType<typeof searchPastEntries>): SentExample[] {
  const ctx = sampleContext();
  const content = buildJournalPrompt({ ...ctx, txn: txn(), walletName: "サンプル銀行", past }).messages[0]!.content;
  expect(typeof content).toBe("string");
  return JSON.parse(content as string).past.examples;
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
  it("品目とメモタグがある過去仕訳は、その ID を代表例の項目に入れる", () => {
    const past = searchPastEntries(txn(), [rentEntry(0, { itemId: 601, tagIds: [501] }), rentEntry(1, { itemId: 601, tagIds: [501, 502] })]);
    const examples = sentExamples(past);
    expect(examples.find((e) => e.entry.description === "1月分 家賃")?.entry).toMatchObject({ itemId: 601, sectionId: 401, tagIds: [501] });
    expect(examples.find((e) => e.entry.description === "2月分 家賃")?.entry).toMatchObject({ itemId: 601, sectionId: 401, tagIds: [501, 502] });
  });

  it("品目とメモタグがない過去仕訳は null と空配列で明示する（AI が勝手に付けないように）", () => {
    const past = searchPastEntries(txn(), [rentEntry(0)]);
    const [example] = sentExamples(past);
    expect(example!.entry).toEqual({ accountItemId: 105, taxCode: 21, partnerId: 302, itemId: null, sectionId: 401, tagIds: [], description: "1月分 家賃" });
  });

  it("取引先・部門が null の例も null のまま出る（キーを落とさない）", () => {
    const [example] = sentExamples(searchPastEntries(txn(), [rentEntry(0, { partnerId: null, sectionId: null })]));
    expect(example!.entry).toHaveProperty("partnerId", null);
    expect(example!.entry).toHaveProperty("sectionId", null);
  });

  it("ある例とない例が混ざっていても、それぞれの例にそのまま出る", () => {
    const past = searchPastEntries(txn(), [rentEntry(0), rentEntry(1, { tagIds: [501] })]);
    const examples = sentExamples(past);
    expect(examples.find((e) => e.entry.description === "1月分 家賃")?.entry.tagIds).toEqual([]);
    expect(examples.find((e) => e.entry.description === "2月分 家賃")?.entry.tagIds).toEqual([501]);
    // 指示にも、代表例に合わせることが書いてある
    const system = buildJournalPrompt({ ...sampleContext(), txn: txn(), walletName: "サンプル銀行", past }).system[0]!.text;
    expect(system).toContain("品目・メモタグも代表例に合わせ");
  });

  it("代表例には日付・金額・明細の摘要も残る", () => {
    const [example] = sentExamples(searchPastEntries(txn(), [rentEntry(0)]));
    expect(example).toMatchObject({ entryDate: "2026-01-01", amount: 165000, bankDescription: "ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ" });
  });

  it("プロンプトの版は、この変更に合わせて更新されている", () => {
    expect(JOURNAL_PROMPT_VERSION).toBe("journal-proposal/2026-10-24.1");
  });
});
