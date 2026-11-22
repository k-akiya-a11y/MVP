import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { readVisibleCustomer } from "../rules/editor-load";
import { UUID } from "../rules/editor-schema";
import { createNoteSchema, NOTE_CREATE_UNKNOWN_MESSAGE } from "./create-schema";
import { formatNoteIssues } from "./editor-schema";

/** 保存の結果。not_saved は「この操作では保存していない」ことが確かな場合だけ。確かでない場合は unknown */
export type CreateNoteResult =
  | { ok: true; noteId: string; version: 1; status: "inactive"; message: string }
  | {
      ok: false;
      outcome: "not_saved";
      code: "invalid" | "unauthenticated" | "not_found" | "conflict" | "denied" | "rejected" | "unavailable";
      message: string;
    }
  | { ok: false; outcome: "unknown"; code: "unknown"; message: string };

const notSaved = (code: Extract<CreateNoteResult, { outcome: "not_saved" }>["code"], message: string): CreateNoteResult => ({
  ok: false,
  outcome: "not_saved",
  code,
  message,
});
const unknown = (): CreateNoteResult => ({ ok: false, outcome: "unknown", code: "unknown", message: NOTE_CREATE_UNKNOWN_MESSAGE });

/** 読込の段階（保存前）の失敗。利用者には固定文だけを見せる */
const UNAVAILABLE_MESSAGE = "保存の準備に必要な情報を読み込めなかったため、保存していません。時間をおいてもう一度お試しください。";

/** DB が文を実行して拒否したことが確かなエラー（関数ごと巻き戻る）。この場合は保存されていない */
const isDefiniteRejection = (code: unknown) =>
  typeof code === "string" && (/^(22|23)[0-9A-Z]{3}$/.test(code) || code === "P0001");

/**
 * 新しい文章メモを「無効」の版1として作る。書込は RPC create_customer_note の1回だけで、親（customer_notes）と
 * 版1（customer_note_versions）は DB 側の1つのトランザクションで入る。
 *
 * - 入力は strict。状態・版・作成者は受け付けない（DB 関数が 'inactive' / 1 / auth.uid() に固定する）。
 * - ログインは auth.getUser() で確認し、顧客は担当者の権限（RLS）で見えることを読み直して確かめる。
 * - 依頼ID（メモID）は画面が固定して渡す。同じIDの2回目は主キー重複（23505）で拒否され、何も上書きしない。
 *   自動の再試行はしない。
 * - 通信の失敗や応答の欠落など、保存されたか確かでないときは unknown を返す。
 */
export async function createCustomerNote(client: SupabaseClient, rawInput: unknown): Promise<CreateNoteResult> {
  const parsed = createNoteSchema.safeParse(rawInput);
  if (!parsed.success) return notSaved("invalid", formatNoteIssues(parsed.error));
  const input = parsed.data;

  try {
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return notSaved("unauthenticated", "ログインが確認できないため、保存していません。ログインし直してください。");
    z.string().regex(UUID).parse(data.user.id);
  } catch {
    return notSaved("unavailable", UNAVAILABLE_MESSAGE);
  }

  // ここまでは書込をしていない。読込の失敗はすべて「保存していない」と言える
  try {
    const customer = await readVisibleCustomer(client, input.customerId);
    if (!customer) return notSaved("not_found", "顧客が見つからないか、この顧客を扱う権限がないため、保存していません。");
  } catch {
    return notSaved("unavailable", UNAVAILABLE_MESSAGE);
  }

  let result;
  try {
    // 送るのはこの4つだけ。状態・版・作成者は DB 関数が決める
    result = await client.rpc("create_customer_note", {
      p_customer_id: input.customerId,
      p_note_id: input.requestId,
      p_title: input.title,
      p_body: input.body,
    });
  } catch {
    return unknown();
  }
  if (result.error) {
    const code: unknown = result.error.code;
    if (code === "23505") {
      return notSaved(
        "conflict",
        "この依頼IDは、すでにメモの作成に使われているため、今回の操作では保存していません（既存のメモは上書きしていません）。文章メモの一覧で、このIDのメモがあるか確認してください。",
      );
    }
    if (code === "42501") return notSaved("denied", "このメモを保存する権限がないため、保存していません。");
    if (isDefiniteRejection(code)) return notSaved("rejected", "データベースが内容を受け付けなかったため、保存していません。入力内容を確認してください。");
    return unknown();
  }

  // 戻り値が自分の渡した依頼IDと一致することを確かめる。違えば保存されたか確かでない
  const returned = z.string().regex(UUID).safeParse(result.data);
  if (!returned.success || returned.data.toLowerCase() !== input.requestId.toLowerCase()) return unknown();

  return {
    ok: true,
    noteId: input.requestId,
    version: 1,
    status: "inactive",
    message: `メモ ${input.requestId} を「無効」の版1として保存しました。AI にはまだ使われません。AI に使うには、文章メモの一覧から編集画面を開き、人が内容を確認して「有効」の新しい版として保存してください。`,
  };
}
