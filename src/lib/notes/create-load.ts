import type { SupabaseClient } from "@supabase/supabase-js";
import { readVisibleCustomer } from "../rules/editor-load";
import { UUID } from "../rules/editor-schema";

/** 読込の失敗を利用者に見せる固定文。SDK・検証エラーの中身は含めない */
export const NOTE_CREATE_LOAD_FAILED_MESSAGE =
  "顧客を読み込めなかったため、表示できません。時間をおいて再読み込みしてください。";

export class NoteCreateLoadError extends Error {
  constructor() {
    super(NOTE_CREATE_LOAD_FAILED_MESSAGE);
    this.name = "NoteCreateLoadError";
  }
}

/**
 * 新規メモ画面の元データ（読取専用）。ログインした担当者の権限（RLS）で見える顧客だけを返し、
 * 見えない・形式が不正なときは null。失敗は NoteCreateLoadError（固定文）にして投げる。
 */
export async function loadNoteCreateSource(client: SupabaseClient, customerId: string): Promise<{ id: string; name: string } | null> {
  if (!UUID.test(customerId)) return null;
  try {
    return await readVisibleCustomer(client, customerId);
  } catch {
    // 中身（SDK・検証エラー・インフラの情報）は利用者にもログにも出さない
    throw new NoteCreateLoadError();
  }
}
