import type { EditorNote } from "./editor-load";
import type { NoteStatus } from "./editor-schema";

/** 編集中の値。画面の入力欄に合わせた文字列。保存されている現在の版から始める */
export type NoteDraft = { title: string; body: string };

export const toDraft = (note: EditorNote): NoteDraft => ({ title: inputText(note.title), body: textareaText(note.body) });

/** <input type="text"> は値から改行を取り除く */
export const inputText = (v: string) => v.replace(/[\r\n]/g, "");
/** <textarea> は値の改行を LF にそろえる */
export const textareaText = (v: string) => v.replace(/\r\n?/g, "\n");

/**
 * 画面の値を、保存の入力（noteEditorSubmitSchema が検証する unknown）にする。
 * 入力欄が改行を正規化するため、利用者が触っていない欄は保存済みの値をそのまま使う
 * （旧い CRLF や改行入りのタイトルを、開いて保存しただけで書き換えない）。
 * 作成者・版番号などは含めない。値の検証はサーバー側のスキーマが行う。
 */
export function draftToInput(args: { customerId: string; note: EditorNote; status: NoteStatus; draft: NoteDraft }): unknown {
  const { note, draft } = args;
  return {
    customerId: args.customerId,
    noteId: note.noteId,
    expectedVersion: note.version,
    status: args.status,
    title: draft.title === inputText(note.title) ? note.title : draft.title,
    body: draft.body === textareaText(note.body) ? note.body : draft.body,
  };
}
