import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// useState を差し替え、保存中（busy）などの状態を指定して描画する（ブラウザ・DOM ライブラリは使わない。入力・クリックの操作は未確認）
// 描画順の useState: NoteEditor = selectedId, notice, reloads / NoteForm = draft, confirmed, busy, locked
const forced = vi.hoisted(() => ({ values: [] as unknown[], calls: 0 }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = forced.calls++ % 7;
      if (i in forced.values) return [forced.values[i], () => {}];
      return [typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}];
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/customers/[customerId]/notes/actions", () => ({ saveNoteVersionAction: vi.fn() }));

import { NoteEditor } from "@/app/customers/[customerId]/notes/note-editor";
import type { EditorNote } from "@/lib/notes/editor-load";
import { CID, NID } from "../fixtures/note-editor";

const note: EditorNote = {
  noteId: NID,
  version: 2,
  status: "active",
  title: "代表者カードの私用分",
  body: "私用分は役員貸付金で処理する。",
  createdAt: "2026-10-01T00:00:00+00:00",
};

type Forced = { confirmed?: boolean; busy?: boolean; locked?: boolean };
const render = (s: Forced = {}) => {
  forced.calls = 0;
  forced.values = [];
  forced.values[0] = NID; // 編集するメモを選んだ状態
  if ("confirmed" in s) forced.values[4] = s.confirmed;
  if ("busy" in s) forced.values[5] = s.busy;
  if ("locked" in s) forced.values[6] = s.locked;
  return renderToStaticMarkup(createElement(NoteEditor, { customerId: CID, notes: [note] }));
};

/** 編集フォーム内のタグだけを取り出す（一覧の「編集する」ボタンは除く） */
const formTags = (html: string) => {
  const form = html.slice(html.indexOf("<form"));
  return {
    title: form.match(/<input[^>]*type="text"[^>]*>/g) ?? [],
    body: form.match(/<textarea[^>]*>/g) ?? [],
    confirm: form.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [],
    buttons: form.match(/<button[^>]*>/g) ?? [],
  };
};
const isDisabled = (t: string) => /\sdisabled=""/.test(t);

beforeEach(() => {
  forced.calls = 0;
  forced.values = [];
});

describe("メモ編集フォームの入力欄の無効化", () => {
  it("保存中（busy）は、タイトル・本文・確認チェック・保存ボタンがすべて無効になる", () => {
    const t = formTags(render({ confirmed: true, busy: true, locked: false }));
    expect(t.title).toHaveLength(1);
    expect(t.body).toHaveLength(1);
    expect(t.confirm).toHaveLength(1);
    expect(t.buttons).toHaveLength(2);
    expect([...t.title, ...t.body, ...t.confirm, ...t.buttons].every(isDisabled)).toBe(true);
  });

  it("保存済み・結果不明・競合のあと（locked）も、すべて無効のまま", () => {
    const html = render({ confirmed: false, busy: false, locked: true });
    const t = formTags(html);
    expect([...t.title, ...t.body, ...t.confirm, ...t.buttons].every(isDisabled)).toBe(true);
    expect(t.title).toHaveLength(1);
    expect(t.body).toHaveLength(1);
    expect(html).toContain("最新の状態を読み込む");
  });

  it("busy でも locked でもないときは、タイトル・本文・確認チェックは有効で、確認済みなら保存ボタンも有効（確認前は無効）", () => {
    const idle = formTags(render({ confirmed: false }));
    expect([...idle.title, ...idle.body, ...idle.confirm].some(isDisabled)).toBe(false);
    expect(idle.buttons.every(isDisabled)).toBe(true);

    const ready = formTags(render({ confirmed: true }));
    expect([...ready.title, ...ready.body, ...ready.confirm, ...ready.buttons].some(isDisabled)).toBe(false);
  });
});
