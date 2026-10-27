import { z } from "zod";
import { UUID } from "../rules/editor-schema";
import { isBlankText, noteText } from "./editor-schema";

/**
 * 新しい文章メモ（無効・版1）を作る画面の入力検証。URL・フォーム・サーバーアクションの値はすべて信用せず
 * （unknown として受け）、ここで検証してから使う。純粋関数のみ（DB・通信はしない）。
 *
 * タイトル・本文は人が明示的に入力した値だけ。空白だけは拒否し、それ以外は前後の空白や改行も含めて入力のまま保つ
 * （長さの上限は設けない）。状態・版・作成者はここにないので strict により拒否する（DB 関数が決める）。
 */

const customerId = z.string("顧客の指定が正しくありません").regex(UUID, "顧客の指定が正しくありません");
const requestId = z.string("依頼IDが正しくありません").regex(UUID, "依頼IDが正しくありません");

/** 新規メモ画面を開くときの URL の検索パラメータ（文字列）。依頼IDだけで、ほかのキーは受け付けない */
export const noteCreateQuerySchema = z.strictObject({ requestId });
export type NoteCreateQuery = z.output<typeof noteCreateQuerySchema>;

/** 保存の入力。依頼IDがそのまま新しいメモのIDになる。状態（無効）・版（1）・作成者は含めない */
export const createNoteSchema = z.strictObject({
  customerId,
  requestId,
  title: noteText("タイトル").refine((v) => !isBlankText(v), "タイトルを入力してください"),
  body: noteText("本文").refine((v) => !isBlankText(v), "本文を入力してください"),
});
export type CreateNoteInput = z.output<typeof createNoteSchema>;

/** 画面の検索パラメータを検証する。同じキーが複数ある（配列）・未知のキー・欠落は拒否する。失敗の中身は返さない */
export function parseNoteCreateQuery(raw: unknown): NoteCreateQuery | null {
  const parsed = noteCreateQuerySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 新規メモ画面へのリンク。依頼IDは呼出側が1リンク（1回の描画）ごとに決める */
export function newNoteHref(customerIdValue: string, requestIdValue: string): string {
  const params = new URLSearchParams();
  params.set("requestId", requestIdValue);
  return `/customers/${encodeURIComponent(customerIdValue)}/notes/new?${params.toString()}`;
}

/** 結果が不明なときの固定文（画面とサーバーで共通。クライアントに読込・DB の処理を持ち込まないためここに置く） */
export const NOTE_CREATE_UNKNOWN_MESSAGE =
  "保存できたかどうかを確認できませんでした。保存されていない、とは言い切れません。自動では再送しません。文章メモの一覧で、このメモID（依頼ID）のメモがあるか確認してください。";
