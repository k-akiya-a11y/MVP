"use server";

import { revalidatePath } from "next/cache";
import { submitRuleVersion, type RuleSubmitResult } from "@/lib/rules/editor-submit";
import { UUID } from "@/lib/rules/editor-schema";
import { createUserClient } from "@/lib/supabase/server";

/**
 * 既存ルールの新しい版を保存する。引数は信用せず、検証・権限確認・作成者の決定は submitRuleVersion が行う。
 * 失敗や結果不明でも自動では再実行しない（画面側の操作でのみやり直す）。
 */
export async function saveRuleVersionAction(input: unknown): Promise<RuleSubmitResult> {
  let result: RuleSubmitResult;
  try {
    result = await submitRuleVersion(await createUserClient(), input);
  } catch {
    // クライアント作成などの想定外の例外。書込に進んだか確かでないので結果不明として扱う
    return {
      ok: false,
      outcome: "unknown",
      code: "unknown",
      message:
        "保存できたかどうかを確認できませんでした。保存されていない、とは言い切れません。自動では再送しません。ページを再読み込みして、ルールの版が増えているか確認してください。",
    };
  }
  if (result.ok || result.outcome === "unknown") {
    const customerId = typeof input === "object" && input !== null && "customerId" in input ? input.customerId : null;
    if (typeof customerId === "string" && UUID.test(customerId)) revalidatePath(`/customers/${customerId}/rules`);
  }
  return result;
}
