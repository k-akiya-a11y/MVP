import { describe, expect, it } from "vitest";
import { draftToInput, inputText, textareaText, toDraft } from "@/lib/notes/editor-draft";
import { toEditorNote, noteVersionRowSchema } from "@/lib/notes/editor-load";
import { formatNoteIssues, noteEditorSubmitSchema } from "@/lib/notes/editor-schema";
import { CID, NID, noteRow, validNoteInput } from "../fixtures/note-editor";

describe("文章メモの保存の入力検証", () => {
  it("正しい入力は通り、タイトル・本文は前後の空白や改行も含めて入力のまま保つ", () => {
    const input = validNoteInput({ title: "  題名 ", body: "\n本文\r\n  " });
    const parsed = noteEditorSubmitSchema.parse(input);
    expect(parsed.title).toBe("  題名 ");
    expect(parsed.body).toBe("\n本文\r\n  ");
  });

  it("未知の項目（作成者・版番号・顧客の上書きなど）は拒否する", () => {
    for (const extra of [{ createdBy: CID }, { created_by: CID }, { version: 9 }, { customer_id: CID }, { source: "staff" }]) {
      expect(noteEditorSubmitSchema.safeParse(validNoteInput(extra)).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("ID・版・状態の形が不正なら拒否する", () => {
    const bad = [
      { customerId: "x" },
      { customerId: 1 },
      { noteId: "not-uuid" },
      { noteId: null },
      { expectedVersion: 0 },
      { expectedVersion: 1.5 },
      { expectedVersion: "2" },
      { expectedVersion: 2_147_483_647 },
      { status: "proposed" },
      { status: "ACTIVE" },
      { status: undefined },
      { title: null },
      { body: 5 },
      { title: "a\u0000b" },
    ];
    for (const o of bad) expect(noteEditorSubmitSchema.safeParse(validNoteInput(o)).success, JSON.stringify(o)).toBe(false);
    expect(noteEditorSubmitSchema.safeParse(null).success).toBe(false);
    expect(noteEditorSubmitSchema.safeParse("x").success).toBe(false);
    expect(noteEditorSubmitSchema.safeParse(validNoteInput({ expectedVersion: 2_147_483_646 })).success).toBe(true);
  });

  it("有効にするときだけ、空白だけのタイトル・本文を拒否する（無効化は止めない）", () => {
    for (const blank of ["", " ", "　", "\n\t\r\n"]) {
      expect(noteEditorSubmitSchema.safeParse(validNoteInput({ title: blank })).success).toBe(false);
      expect(noteEditorSubmitSchema.safeParse(validNoteInput({ body: blank })).success).toBe(false);
      expect(noteEditorSubmitSchema.safeParse(validNoteInput({ status: "inactive", title: blank, body: blank })).success).toBe(true);
    }
  });

  it("長さの上限は設けない（長い保存済みのメモも無効化できる）", () => {
    const long = "あ".repeat(100_000);
    expect(noteEditorSubmitSchema.safeParse(validNoteInput({ status: "inactive", title: long, body: long })).success).toBe(true);
    expect(noteEditorSubmitSchema.safeParse(validNoteInput({ title: long, body: long })).success).toBe(true);
  });

  it("検証エラーの文章に入力値を含めない", () => {
    const result = noteEditorSubmitSchema.safeParse(validNoteInput({ title: " ", secret: "sk-secret-x" }));
    expect(result.success).toBe(false);
    if (!result.success) expect(formatNoteIssues(result.error)).not.toContain("sk-secret");
  });
});

describe("画面の入力と保存の入力の変換", () => {
  const note = toEditorNote(noteVersionRowSchema.parse(noteRow({ title: "題名", body: "一行目\r\n二行目" })));

  it("触っていない欄は、入力欄が改行を正規化しても保存済みの値のまま送る", () => {
    const legacy = toEditorNote(noteVersionRowSchema.parse(noteRow({ title: "改行\r\n入り", body: "a\r\nb\rc" })));
    const draft = toDraft(legacy);
    expect(draft.title).toBe("改行入り");
    expect(draft.body).toBe("a\nb\nc");
    const input = draftToInput({ customerId: CID, note: legacy, status: "inactive", draft }) as { title: string; body: string };
    expect(input.title).toBe("改行\r\n入り");
    expect(input.body).toBe("a\r\nb\rc");
  });

  it("触った欄は入力のまま送り、作成者・版番号は含めず、編集元の版を渡す", () => {
    const input = draftToInput({ customerId: CID, note, status: "active", draft: { title: "新題名", body: "新本文" } });
    expect(input).toEqual({ customerId: CID, noteId: NID, expectedVersion: 2, status: "active", title: "新題名", body: "新本文" });
    expect(noteEditorSubmitSchema.safeParse(input).success).toBe(true);
  });

  it("正規化関数", () => {
    expect(inputText("a\r\nb")).toBe("ab");
    expect(textareaText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});
