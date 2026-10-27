import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { readVisibleCustomer } from "../rules/editor-load";
import { UUID } from "../rules/editor-schema";
import { NOTE_VERSION_COLUMNS, noteVersionRowSchema, type NoteVersionRow } from "./editor-load";
import { formatNoteIssues, NOTE_STATUS_LABEL, noteEditorSubmitSchema, type NoteEditorInput, type NoteStatus } from "./editor-schema";

/** 保存の結果。not_saved は「この操作では保存していない」ことが確かな場合だけ。確かでない場合は unknown */
export type NoteSubmitResult =
  | { ok: true; noteId: string; version: number; status: NoteStatus; message: string }
  | {
      ok: false;
      outcome: "not_saved";
      code: "invalid" | "unauthenticated" | "not_found" | "stale" | "conflict" | "denied" | "rejected" | "unavailable";
      message: string;
    }
  | { ok: false; outcome: "unknown"; code: "unknown"; message: string };

export const UNKNOWN_OUTCOME_MESSAGE =
  "保存できたかどうかを確認できませんでした。保存されていない、とは言い切れません。自動では再送しません。ページを再読み込みして、メモの版が増えているか確認してから、必要な場合だけもう一度操作してください。";

const notSaved = (code: Extract<NoteSubmitResult, { outcome: "not_saved" }>["code"], message: string): NoteSubmitResult => ({
  ok: false,
  outcome: "not_saved",
  code,
  message,
});
const unknown = (): NoteSubmitResult => ({ ok: false, outcome: "unknown", code: "unknown", message: UNKNOWN_OUTCOME_MESSAGE });

/** 読込の段階（保存前）の失敗。利用者には固定文だけを見せる */
const UNAVAILABLE_MESSAGE = "保存の準備に必要な情報を読み込めなかったため、保存していません。時間をおいてもう一度お試しください。";

/** DB が行を拒否したことが確かなエラー（文を実行して失敗した）。この場合は保存されていない */
const isDefiniteRejection = (code: unknown) =>
  typeof code === "string" && (/^(22|23)[0-9A-Z]{3}$/.test(code) || code === "P0001");

/**
 * 既存メモの新しい版を1つ追加する（customer_note_versions への INSERT だけ。親・既存の版は更新も削除もしない）。
 *
 * - 権限: ログインした担当者の権限（RLS）で動く。顧客・親メモ・最新の版は、その権限で見える行だけを使い、
 *   すべて customer_id を明示して絞り、返った行の顧客も照合する。作成者は auth.getUser() の結果で決め、
 *   版番号は expectedVersion + 1。入力に含まれたこれらの値は受け付けない。
 * - 競合: 最新の版が expectedVersion と違えば保存しない。同時に同じ版を入れた場合は主キーが片方を拒否する（23505）。
 *   どちらも自動では再試行しない。
 * - 通信の失敗や応答の欠落など、保存されたか確かでないときは unknown を返す。
 */
export async function submitNoteVersion(client: SupabaseClient, rawInput: unknown): Promise<NoteSubmitResult> {
  const parsed = noteEditorSubmitSchema.safeParse(rawInput);
  if (!parsed.success) return notSaved("invalid", formatNoteIssues(parsed.error));
  const input = parsed.data;

  let userId: string;
  try {
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return notSaved("unauthenticated", "ログインが確認できないため、保存していません。ログインし直してください。");
    userId = z.string().regex(UUID).parse(data.user.id);
  } catch {
    return notSaved("unavailable", UNAVAILABLE_MESSAGE);
  }

  // ここまでは書込をしていない。読込の失敗はすべて「保存していない」と言える
  let current: NoteVersionRow;
  try {
    const customer = await readVisibleCustomer(client, input.customerId);
    if (!customer) return notSaved("not_found", "顧客が見つからないか、この顧客を扱う権限がないため、保存していません。");

    const parent = await client
      .from("customer_notes")
      .select("id, customer_id")
      .eq("id", input.noteId)
      .eq("customer_id", input.customerId)
      .maybeSingle();
    if (parent.error) throw new Error("parent read failed");
    const parentRow = z.object({ id: z.string(), customer_id: z.string() }).nullable().parse(parent.data);
    if (!parentRow) return notSaved("not_found", "メモが見つからないか、この顧客のメモではないため、保存していません。");
    if (parentRow.id !== input.noteId || parentRow.customer_id !== input.customerId) throw new Error("parent mismatch");

    const versions = await client
      .from("customer_note_versions")
      .select(NOTE_VERSION_COLUMNS)
      .eq("note_id", input.noteId)
      .eq("customer_id", input.customerId)
      .order("version", { ascending: false })
      .limit(1);
    if (versions.error) throw new Error("version read failed");
    const latest = z.array(noteVersionRowSchema).parse(versions.data)[0];
    if (!latest) throw new Error("no version");
    if (latest.note_id !== input.noteId || latest.customer_id !== input.customerId) throw new Error("version mismatch");
    current = latest;
  } catch {
    return notSaved("unavailable", UNAVAILABLE_MESSAGE);
  }

  if (current.version !== input.expectedVersion) {
    return notSaved(
      "stale",
      `このメモは編集を始めたあとに更新されています（編集元: 版${input.expectedVersion}、現在: 版${current.version}）。保存していません。最新を読み込み直して、変更内容を確認してからやり直してください。`,
    );
  }

  const nextVersion = input.expectedVersion + 1;
  const row = buildInsertRow(input, nextVersion, userId);

  let result;
  try {
    result = await client.from("customer_note_versions").insert(row).select(NOTE_VERSION_COLUMNS).single();
  } catch {
    return unknown();
  }
  if (result.error) {
    const code: unknown = result.error.code;
    if (code === "23505") {
      return notSaved("conflict", "同じ版が別の操作で先に保存されたため、保存していません。最新を読み込み直して、変更内容を確認してからやり直してください。");
    }
    if (code === "42501") return notSaved("denied", "このメモを保存する権限がないため、保存していません。");
    if (isDefiniteRejection(code)) return notSaved("rejected", "データベースが入力を受け付けなかったため、保存していません。入力内容を確認してください。");
    return unknown();
  }

  // 戻り値が自分の書いた内容（メモ・顧客・版・状態・作成者・タイトル・本文）と一致することを確かめる。違えば保存されたか確かでない
  const saved = noteVersionRowSchema.safeParse(result.data);
  if (
    !saved.success ||
    saved.data.note_id !== input.noteId ||
    saved.data.customer_id !== input.customerId ||
    saved.data.version !== nextVersion ||
    saved.data.status !== input.status ||
    saved.data.created_by !== userId ||
    saved.data.title !== input.title ||
    saved.data.body !== input.body
  ) {
    return unknown();
  }
  return {
    ok: true,
    noteId: input.noteId,
    version: nextVersion,
    status: input.status,
    message: `メモ ${input.noteId} の版${nextVersion}を「${NOTE_STATUS_LABEL[input.status]}」として保存しました。以前の版は残っています。`,
  };
}

function buildInsertRow(input: NoteEditorInput, version: number, userId: string) {
  return {
    note_id: input.noteId,
    version,
    customer_id: input.customerId,
    status: input.status,
    title: input.title,
    body: input.body,
    created_by: userId,
  };
}
