import { z } from "zod";
import type { AiCallResult, JournalAi } from "@/lib/ai/client";
import type { AiJournalOutput } from "@/lib/ai/schema";

/**
 * 実結合の確認用の「偽のモデル」。Claude API を呼ばず、費用もかからない（このファイルは SDK を import しない）。
 * アプリのコード（src/）には入れない。tests/integration/mock-propose.run.ts から候補生成ジョブに渡すだけ。
 *
 * 返し方（決まった規則だけ。精度の評価には使えない）:
 * - 参考データの過去仕訳で最も多い「科目×税区分」の代表例があれば、その仕訳（取引先・品目・部門・タグ・摘要）をそのまま提案する
 * - 過去仕訳がなければ cannot_decide にして、不明点を書く
 * - 10万円以上は固定資産の可能性あり、役員・個人は常に false
 * 判断ログで本物の AI と区別できるよう、モデル名は MOCK_MODEL にし、使用量と費用は 0 にする。
 */
export const MOCK_MODEL = "mock/past-majority (Claude API を呼ばない検証用)";

const referenceSchema = z.object({
  transaction: z.object({ amount: z.number().int() }),
  past: z.object({
    combos: z.array(z.object({ accountItemId: z.number().int(), taxCode: z.number().int(), count: z.number().int() })),
    examples: z.array(
      z.object({
        entry: z.object({
          accountItemId: z.number().int(),
          taxCode: z.number().int(),
          partnerId: z.number().int().nullable(),
          itemId: z.number().int().nullable(),
          sectionId: z.number().int().nullable(),
          tagIds: z.array(z.number().int()),
          description: z.string(),
        }),
      }),
    ),
  }),
});

const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdMicros: 0 };

/** プロンプト（user の参考データ JSON）から、決まった規則で回答を作る */
export function mockJournalOutput(referenceJson: string): AiJournalOutput {
  const ref = referenceSchema.parse(JSON.parse(referenceJson));
  const top = [...ref.past.combos].sort((a, b) => b.count - a.count)[0];
  const example = top && ref.past.examples.find((e) => e.entry.accountItemId === top.accountItemId && e.entry.taxCode === top.taxCode);
  const fixedAsset = ref.transaction.amount >= 100_000;
  if (!example) {
    return {
      decision: "cannot_decide",
      account_item_id: null,
      tax_code: null,
      partner_id: null,
      item_id: null,
      section_id: null,
      tag_ids: [],
      description: "",
      reason: "（検証用の偽のモデル）過去仕訳がないため判断しません",
      unknowns: ["（検証用の偽のモデル）過去仕訳がなく、取引の内容が分かりません"],
      fixed_asset_possible: fixedAsset,
      officer_or_personal: false,
    };
  }
  const e = example.entry;
  return {
    decision: "proposal",
    account_item_id: e.accountItemId,
    tax_code: e.taxCode,
    partner_id: e.partnerId,
    item_id: e.itemId,
    section_id: e.sectionId,
    tag_ids: [...e.tagIds],
    description: e.description,
    reason: `（検証用の偽のモデル）過去仕訳で最も多い組合せ（${top.count}件）の代表例をそのまま返しました`,
    unknowns: [],
    fixed_asset_possible: fixedAsset,
    officer_or_personal: false,
  };
}

export const mockJournalAi: JournalAi = async (prompt) => {
  const first = prompt.messages[0];
  const content = first && typeof first.content === "string" ? first.content : "";
  const result: AiCallResult = {
    status: "ok",
    output: mockJournalOutput(content),
    model: MOCK_MODEL,
    promptVersion: "mock/none",
    usage: zeroUsage,
  };
  return result;
};
