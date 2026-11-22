"use server";

import { revalidatePath } from "next/cache";
import { CREATE_UNKNOWN_MESSAGE } from "@/lib/rules/candidate-schema";
import { createRuleFromCandidate, type CreateRuleResult } from "@/lib/rules/candidate-submit";
import { UUID } from "@/lib/rules/editor-schema";
import { createUserClient } from "@/lib/supabase/server";

/**
 * 過去仕訳の候補から新しいルール（提案中）を保存する。引数は信用せず、検証・権限確認・作成者の決定は
 * createRuleFromCandidate と DB 関数が行う。失敗や結果不明でも自動では再実行しない。
 */
export async function createRuleFromCandidateAction(input: unknown): Promise<CreateRuleResult> {
  let result: CreateRuleResult;
  try {
    result = await createRuleFromCandidate(await createUserClient(), input);
  } catch {
    // クライアント作成などの想定外の例外。書込に進んだか確かでないので結果不明として扱う
    return { ok: false, outcome: "unknown", code: "unknown", message: CREATE_UNKNOWN_MESSAGE };
  }
  if (result.ok || result.outcome === "unknown") {
    const customerId = typeof input === "object" && input !== null && "customerId" in input ? input.customerId : null;
    if (typeof customerId === "string" && UUID.test(customerId)) revalidatePath(`/customers/${customerId}/rules`);
  }
  return result;
}
