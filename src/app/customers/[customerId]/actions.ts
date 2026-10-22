"use server";

import { revalidatePath } from "next/cache";
import { submitDuplicateResolution, submitReview, type DuplicateResolutionInput, type ReviewInput } from "@/lib/review/submit";
import { createUserClient } from "@/lib/supabase/server";

/** 承認・修正・保留・却下を1件記録する（freee への登録はしない。承認済みの実行は別の層が行う） */
export async function reviewAction(customerId: string, input: ReviewInput) {
  const client = await createUserClient();
  const result = await submitReview(client, input);
  revalidatePath(`/customers/${customerId}`);
  return result;
}

/** 確信度「高」をまとめて承認する。1件ずつ記録し、失敗した分を返す */
export async function bulkApproveAction(customerId: string, items: { decisionId: string; reviewSeconds: number }[]) {
  const client = await createUserClient();
  const failures: { decisionId: string; error: string }[] = [];
  for (const item of items) {
    const result = await submitReview(client, {
      decisionId: item.decisionId,
      action: "approve",
      finalEntry: null,
      reason: null,
      reviewSeconds: item.reviewSeconds,
      bulk: true,
    });
    if (!result.ok) failures.push({ decisionId: item.decisionId, error: result.error });
  }
  revalidatePath(`/customers/${customerId}`);
  return { approved: items.length - failures.length, failures };
}

/** 重複の疑いがある明細を「別の取引」か「重複」に決める */
export async function resolveDuplicateAction(customerId: string, input: DuplicateResolutionInput) {
  const client = await createUserClient();
  const result = await submitDuplicateResolution(client, input);
  revalidatePath(`/customers/${customerId}`);
  return result;
}
