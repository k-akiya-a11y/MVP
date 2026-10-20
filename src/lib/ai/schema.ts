import { z } from "zod";

/**
 * AI の回答形式（構造化出力）。AI は提案を返すだけで、ここから何かを実行することはない。
 * 確信度は AI に聞かない（プログラムで計算する）。
 */
export const aiJournalOutputSchema = z.object({
  decision: z.enum(["proposal", "cannot_decide"]).describe("仕訳を提案できるなら proposal、判断できないなら cannot_decide"),
  account_item_id: z.number().int().nullable().describe("勘定科目の ID（マスタの一覧から選ぶ）"),
  tax_code: z.number().int().nullable().describe("税区分コード（マスタの一覧から選ぶ）"),
  partner_id: z.number().int().nullable().describe("取引先の ID。該当がなければ null"),
  item_id: z.number().int().nullable().describe("品目の ID。該当がなければ null"),
  section_id: z.number().int().nullable().describe("部門の ID。該当がなければ null"),
  tag_ids: z.array(z.number().int()).describe("メモタグの ID。該当がなければ空"),
  description: z.string().describe("freee に登録する摘要"),
  reason: z.string().describe("この仕訳にした理由（参照した過去仕訳・ルール・メモ）"),
  unknowns: z.array(z.string()).describe("判断に足りない情報・担当者に確認したいこと"),
  fixed_asset_possible: z.boolean().describe("固定資産として計上すべき可能性があるか"),
  officer_or_personal: z.boolean().describe("役員・個人（私用・立替・貸付）が絡む可能性があるか"),
});

export type AiJournalOutput = z.infer<typeof aiJournalOutputSchema>;
