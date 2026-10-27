"use server";

import { revalidatePath } from "next/cache";
import { submitNoteVersion, UNKNOWN_OUTCOME_MESSAGE, type NoteSubmitResult } from "@/lib/notes/editor-submit";
import { UUID } from "@/lib/rules/editor-schema";
import { createUserClient } from "@/lib/supabase/server";

/**
 * 既存メモの新しい版を保存する。引数は信用せず、検証・権限確認・作成者の決定は submitNoteVersion が行う。
 * 失敗や結果不明でも自動では再実行しない（画面側の操作でのみやり直す）。
 */
export async function saveNoteVersionAction(input: unknown): Promise<NoteSubmitResult> {
  let result: NoteSubmitResult;
  try {
    result = await submitNoteVersion(await createUserClient(), input);
  } catch {
    // クライアント作成などの想定外の例外。書込に進んだか確かでないので結果不明として扱う
    return { ok: false, outcome: "unknown", code: "unknown", message: UNKNOWN_OUTCOME_MESSAGE };
  }
  if (result.ok || result.outcome === "unknown") {
    const customerId = typeof input === "object" && input !== null && "customerId" in input ? input.customerId : null;
    if (typeof customerId === "string" && UUID.test(customerId)) revalidatePath(`/customers/${customerId}/notes`);
  }
  return result;
}
