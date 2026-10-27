import { z } from "zod";
import { UUID } from "../rules/editor-schema";

/**
 * 既存の文章メモの編集画面（新しい版の保存）の入力検証。外部から来る値（画面・サーバーアクションの引数）は
 * すべて unknown として受け、ここで検証してから使う。純粋関数のみ（DB・通信はしない）。
 * DB の check 制約（customer_note_versions: version >= 1、status は active / inactive）と同じ範囲を保つ。
 *
 * 文字数の上限は設けない（保存済みの長いメモを無効化できなくなるため）。タイトル・本文は前後の空白や改行も含めて
 * 入力のまま保つ。「有効」で保存するときだけ、タイトルと本文が空白以外を含むことを求める（無効化は空白だけの
 * 保存済みメモでも止めない）。
 */

export const NOTE_STATUSES = ["active", "inactive"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];
export const NOTE_STATUS_LABEL: Record<NoteStatus, string> = { active: "有効", inactive: "無効" };

const INT32_MAX = 2_147_483_647;

/** 前後の空白を除いても何も残らない（全角空白・改行を含む）か */
export const isBlankText = (v: string) => /^[\s　]*$/.test(v);

/** Postgres の text 列に入らない NUL 文字を含むか */
const hasNul = (v: string) => v.includes("\u0000");

const text = (label: string) =>
  z.string(`${label}は文字列で指定してください`).refine((v) => !hasNul(v), `${label}に使えない文字（NUL）が含まれています`);

/** 新規作成の入力でも同じ検証（文字列・NUL なし）を使う */
export const noteText = text;

/**
 * 新しい版の保存の入力。customerId / noteId / expectedVersion は「どの版を元に編集したか」を示す。
 * 作成者・版番号・顧客の上書きなど、ここにない項目は strict により拒否する（サーバーが決める）。
 */
export const noteEditorSubmitSchema = z
  .strictObject({
    customerId: z.string("顧客の指定が正しくありません").regex(UUID, "顧客の指定が正しくありません"),
    noteId: z.string("メモの指定が正しくありません").regex(UUID, "メモの指定が正しくありません"),
    expectedVersion: z
      .number("編集元の版が正しくありません")
      .int("編集元の版が正しくありません")
      .min(1, "編集元の版が正しくありません")
      // 保存する版（+1）が int32 に収まること
      .max(INT32_MAX - 1, "編集元の版が正しくありません"),
    status: z.enum(NOTE_STATUSES, "状態が正しくありません"),
    title: text("タイトル"),
    body: text("本文"),
  })
  .superRefine((v, ctx) => {
    if (v.status !== "active") return;
    if (isBlankText(v.title)) ctx.addIssue({ code: "custom", path: ["title"], message: "有効にするには、タイトルを入力してください" });
    if (isBlankText(v.body)) ctx.addIssue({ code: "custom", path: ["body"], message: "有効にするには、本文を入力してください" });
  });

export type NoteEditorInput = z.output<typeof noteEditorSubmitSchema>;

/** 検証エラーを利用者向けの文章にする（入力値そのものや内部の経路は含めない） */
export function formatNoteIssues(error: z.ZodError): string {
  const messages: string[] = [];
  for (const issue of error.issues) {
    const message = issue.code === "unrecognized_keys" ? "指定できない項目が含まれています" : issue.message;
    if (!messages.includes(message)) messages.push(message);
  }
  return messages.slice(0, 3).join(" / ") || "入力が不正です";
}
