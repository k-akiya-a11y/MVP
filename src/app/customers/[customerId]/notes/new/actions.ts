"use server";

import { revalidatePath } from "next/cache";
import { NOTE_CREATE_UNKNOWN_MESSAGE } from "@/lib/notes/create-schema";
import { createCustomerNote, type CreateNoteResult } from "@/lib/notes/create-submit";
import { UUID } from "@/lib/rules/editor-schema";
import { createUserClient } from "@/lib/supabase/server";

/**
 * 新しい文章メモを「無効」の版1として保存する。引数は信用せず、検証・権限確認・作成者の決定は
 * createCustomerNote と DB 関数が行う。失敗や結果不明でも自動では再実行しない。
 */
export async function createCustomerNoteAction(input: unknown): Promise<CreateNoteResult> {
  let result: CreateNoteResult;
  try {
    result = await createCustomerNote(await createUserClient(), input);
  } catch {
    // クライアント作成などの想定外の例外。書込に進んだか確かでないので結果不明として扱う
    return { ok: false, outcome: "unknown", code: "unknown", message: NOTE_CREATE_UNKNOWN_MESSAGE };
  }
  if (result.ok || result.outcome === "unknown") {
    const customerId = typeof input === "object" && input !== null && "customerId" in input ? input.customerId : null;
    if (typeof customerId === "string" && UUID.test(customerId)) revalidatePath(`/customers/${customerId}/notes`);
  }
  return result;
}
