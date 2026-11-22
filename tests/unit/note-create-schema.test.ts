import { describe, expect, it } from "vitest";
import { createNoteSchema, newNoteHref, parseNoteCreateQuery } from "@/lib/notes/create-schema";
import { CID, NID } from "../fixtures/note-editor";

const valid = (o: Record<string, unknown> = {}) => ({ customerId: CID, requestId: NID, title: "題名", body: "本文", ...o });

describe("新規メモの入力検証（純粋関数）", () => {
  it("正しい入力を、前後の空白・改行も含めて入力のまま受け付ける", () => {
    const r = createNoteSchema.safeParse(valid({ title: " 題名 ", body: "\n一行目\r\n二行目\n" }));
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ title: " 題名 ", body: "\n一行目\r\n二行目\n" });
  });

  it("長い文章も切り詰めず受け付ける（長さの上限は設けない）", () => {
    const long = "あ".repeat(100_000);
    expect(createNoteSchema.safeParse(valid({ body: long })).data?.body).toBe(long);
  });

  it("空・空白だけ（全角空白・改行・JS の trim が削る文字）のタイトル・本文は拒否する", () => {
    for (const blank of ["", " ", "　", "\n\t", "\u000b", " ﻿  ", " 　"]) {
      expect(createNoteSchema.safeParse(valid({ title: blank })).success, JSON.stringify(blank)).toBe(false);
      expect(createNoteSchema.safeParse(valid({ body: blank })).success, JSON.stringify(blank)).toBe(false);
    }
  });

  it("NUL・文字列以外・欠落を拒否する", () => {
    for (const o of [{ title: "a\u0000b" }, { body: "a\u0000" }, { title: 1 }, { body: null }, { title: undefined }, { body: undefined }]) {
      expect(createNoteSchema.safeParse(valid(o)).success, JSON.stringify(o)).toBe(false);
    }
  });

  it("顧客ID・依頼IDがUUIDでない・欠落は拒否する", () => {
    for (const o of [{ customerId: "x" }, { requestId: "x" }, { requestId: "" }, { customerId: undefined }, { requestId: undefined }, { requestId: 1 }]) {
      expect(createNoteSchema.safeParse(valid(o)).success, JSON.stringify(o)).toBe(false);
    }
  });

  it("状態・版・作成者・メモIDなどの上書きは strict で拒否する", () => {
    for (const o of [{ status: "active" }, { status: "inactive" }, { version: 1 }, { createdBy: CID }, { created_by: CID }, { noteId: NID }, { expectedVersion: 1 }]) {
      expect(createNoteSchema.safeParse(valid(o)).success, JSON.stringify(o)).toBe(false);
    }
  });

  it("URL の検索パラメータは依頼IDだけを受け付け、欠落・配列・未知のキー・不正な形式は null", () => {
    expect(parseNoteCreateQuery({ requestId: NID })).toEqual({ requestId: NID });
    for (const raw of [{}, { requestId: [NID, NID] }, { requestId: "x" }, { requestId: NID, status: "active" }, { requestId: undefined }, null, "x"]) {
      expect(parseNoteCreateQuery(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("リンクは顧客IDと依頼IDをエンコードし、フォームの初期値・状態は含めない", () => {
    const href = newNoteHref(CID, NID);
    expect(href).toBe(`/customers/${CID}/notes/new?requestId=${NID}`);
    expect(href).not.toMatch(/title|body|status/);
  });
});
