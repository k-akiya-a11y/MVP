import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const reviewInputSchema = z
  .object({
    decisionId: z.string().uuid(),
    action: z.enum(["approve", "correct", "hold", "reject"]),
    finalEntry: z
      .object({
        account_item_id: z.number().int(),
        tax_code: z.number().int(),
        partner_id: z.number().int().nullable(),
        item_id: z.number().int().nullable(),
        section_id: z.number().int().nullable(),
        tag_ids: z.array(z.number().int()),
        description: z.string().max(250),
      })
      .nullable(),
    reason: z.string().max(1000).nullable(),
    reviewSeconds: z.number().int().min(0).max(86_400),
    bulk: z.boolean(),
  })
  .refine((v) => (v.action === "correct") === (v.finalEntry !== null), {
    message: "修正のときだけ確定内容を指定します",
  });

export type ReviewInput = z.infer<typeof reviewInputSchema>;

/**
 * 人の確認を記録する（record_human_review）。ログインした担当者の権限で呼ぶので、確認者は DB 側で
 * auth.uid() に固定され、他人の名前では記録できない。外部（freee）への書込はここではしない。
 */
export async function submitReview(client: SupabaseClient, input: ReviewInput): Promise<{ ok: true; reviewId: string } | { ok: false; error: string }> {
  const parsed = reviewInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "入力が不正です" };
  const v = parsed.data;
  const { data, error } = await client.rpc("record_human_review", {
    p_ai_decision_id: v.decisionId,
    p_action: v.action,
    p_final_entry: v.finalEntry,
    p_reason: v.reason,
    p_review_seconds: v.reviewSeconds,
    p_bulk: v.bulk,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, reviewId: z.string().parse(data) };
}
