import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { readVisibleCustomer } from "../rules/editor-load";
import { UUID } from "../rules/editor-schema";
import { fetchAll } from "../supabase/fetch-all";
import { NOTE_STATUSES, type NoteStatus } from "./editor-schema";

/** 読込の失敗を利用者に見せる固定文。SDK・検証エラーの中身は含めない */
export const NOTE_LOAD_FAILED_MESSAGE =
  "メモを読み込めなかったため、表示できません（「メモなし」ではありません）。時間をおいて再読み込みしてください。";

export class NoteEditorLoadError extends Error {
  constructor() {
    super(NOTE_LOAD_FAILED_MESSAGE);
    this.name = "NoteEditorLoadError";
  }
}

const int32 = z.number().int().min(-2_147_483_648).max(2_147_483_647);

/** 版の行から読む列（保存時の戻り値の確認にも使う） */
export const NOTE_VERSION_COLUMNS = "note_id, version, customer_id, status, title, body, created_by, created_at";

export const noteVersionRowSchema = z.object({
  note_id: z.string().regex(UUID),
  version: int32.min(1),
  customer_id: z.string().regex(UUID),
  status: z.enum(NOTE_STATUSES),
  title: z.string(),
  body: z.string(),
  created_by: z.string().nullable(),
  created_at: z.string(),
});
export type NoteVersionRow = z.output<typeof noteVersionRowSchema>;

/** 画面に出す、メモの現在の版（保存されている値そのまま。補完・整形・切り詰めはしない） */
export type EditorNote = {
  noteId: string;
  version: number;
  status: NoteStatus;
  title: string;
  body: string;
  createdAt: string;
};

export const toEditorNote = (row: NoteVersionRow): EditorNote => ({
  noteId: row.note_id,
  version: row.version,
  status: row.status,
  title: row.title,
  body: row.body,
  createdAt: row.created_at,
});

export type NoteEditorData = {
  customer: { id: string; name: string };
  /** 各メモの現在の版（作成日時 → ID の順） */
  notes: EditorNote[];
};

const parentRowSchema = z.object({ id: z.string().regex(UUID), customer_id: z.string() });

/**
 * 既存メモの編集画面のデータ（読取専用）。顧客が見えないときは null。
 * 失敗はすべて NoteEditorLoadError（固定文）にして投げ、空の一覧と区別する。
 */
export async function loadNoteEditor(client: SupabaseClient, customerId: string): Promise<NoteEditorData | null> {
  if (!UUID.test(customerId)) return null;
  try {
    const customer = await readVisibleCustomer(client, customerId);
    if (!customer) return null;

    const parentRows = await fetchAll("メモ", (from, to) =>
      client.from("customer_notes").select("id, customer_id").eq("customer_id", customerId).order("id").range(from, to),
    );
    const parents = z.array(parentRowSchema).parse(parentRows);
    if (parents.some((p) => p.customer_id !== customerId)) throw new Error("note tenant mismatch");
    const parentIds = new Set(parents.map((p) => p.id));

    // 現在の版 = メモごとに version が最大の行（current_customer_notes は security_invoker で RLS が効く）
    const versionRows = await fetchAll("メモの現在の版", (from, to) =>
      client.from("current_customer_notes").select(NOTE_VERSION_COLUMNS).eq("customer_id", customerId).order("note_id").range(from, to),
    );
    const versions = z.array(noteVersionRowSchema).parse(versionRows);
    const seen = new Set<string>();
    for (const v of versions) {
      if (v.customer_id !== customerId) throw new Error("version tenant mismatch");
      if (!parentIds.has(v.note_id)) throw new Error("version without visible parent");
      if (seen.has(v.note_id)) throw new Error("duplicate current version");
      seen.add(v.note_id);
    }

    const notes = versions.map(toEditorNote).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.noteId.localeCompare(b.noteId));
    return { customer: { id: customer.id, name: customer.name }, notes };
  } catch {
    // 中身（SDK・検証エラー・インフラの情報）は利用者にもログにも出さない
    throw new NoteEditorLoadError();
  }
}
