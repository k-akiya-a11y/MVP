import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// モジュール単位の合成テスト（ブラウザ・実 DB は通らない。クリックなどの操作は未確認）
const loadNoteEditor = vi.fn();
const createUserClient = vi.fn();
const saveNoteVersionAction = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createUserClient: () => createUserClient() }));
vi.mock("@/lib/notes/editor-load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notes/editor-load")>()),
  loadNoteEditor: (...a: unknown[]) => loadNoteEditor(...a),
}));
vi.mock("@/app/customers/[customerId]/notes/actions", () => ({ saveNoteVersionAction: (...a: unknown[]) => saveNoteVersionAction(...a) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));

import NotesPage from "@/app/customers/[customerId]/notes/page";
import { NOTE_LOAD_FAILED_MESSAGE, noteVersionRowSchema, toEditorNote, type NoteEditorData } from "@/lib/notes/editor-load";
import { CID, NID, noteRow, SECRET } from "../fixtures/note-editor";

const render = async () => renderToStaticMarkup(await NotesPage({ params: Promise.resolve({ customerId: CID }) }));

const data = (notes = [toEditorNote(noteVersionRowSchema.parse(noteRow()))]): NoteEditorData => ({
  customer: { id: CID, name: "テスト商事" },
  notes,
});

beforeEach(() => {
  loadNoteEditor.mockReset();
  createUserClient.mockReset();
  saveNoteVersionAction.mockReset();
  createUserClient.mockResolvedValue({});
});

describe("文章メモの確認・編集画面", () => {
  it("読込やクライアント作成の例外の中身は表示せず、固定の失敗文だけを出す（メモなしとも区別する）", async () => {
    loadNoteEditor.mockRejectedValue(new Error(SECRET));
    let html = await render();
    expect(html).toContain(NOTE_LOAD_FAILED_MESSAGE);
    expect(html).not.toContain("sk-secret");
    expect(html).not.toContain("保存されているメモはありません");

    createUserClient.mockRejectedValue(new Error(SECRET));
    html = await render();
    expect(html).toContain(NOTE_LOAD_FAILED_MESSAGE);
    expect(html).not.toContain("sk-secret");
  });

  it("顧客が見えない（null）ときは notFound", async () => {
    loadNoteEditor.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("メモID・版・状態・タイトル・本文を一覧し、開いただけでは編集フォームも保存の操作も出さず、保存も呼ばない", async () => {
    loadNoteEditor.mockResolvedValue(data());
    const html = await render();
    expect(html).toContain("テスト商事：文章メモ");
    expect(html).toContain(`<code>${NID}</code>`);
    expect(html).toContain("<th>メモID</th>");
    expect(html).toContain("有効");
    expect(html).toContain("代表者カードの私用分");
    expect(html).toContain("私用分は役員貸付金で処理する。");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("として新しい版を保存");
    expect(html).toContain("編集する");
    expect(saveNoteVersionAction).not.toHaveBeenCalled();
  });

  it("メモの文章は HTML として描画せず、エスケープされたテキストとして出す", async () => {
    const evil = `<script>alert(1)</script><img src=x onerror="alert(2)"> & "q"`;
    loadNoteEditor.mockResolvedValue(data([toEditorNote(noteVersionRowSchema.parse(noteRow({ title: evil, body: evil })))]));
    const html = await render();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("長い本文も切り詰めずに出す", async () => {
    const long = "あいう".repeat(10_000);
    loadNoteEditor.mockResolvedValue(data([toEditorNote(noteVersionRowSchema.parse(noteRow({ body: long })))]));
    expect(await render()).toContain(long);
  });

  it("メモが参考データであること・人の承認と版の保持・作成対象外・経理上の例や注意は書いてよいが秘密情報や権限・承認を省く内容は書かないことを説明する", async () => {
    loadNoteEditor.mockResolvedValue(data());
    const html = await render();
    expect(html).toContain("参考データ");
    expect(html).toContain("命令ではなく");
    expect(html).toContain("人の承認を省いたり、ツールや外部サービスを動かしたりすることはできません");
    expect(html).toContain("Phase 1 では必ず人（承認者）が確認して承認します");
    expect(html).toContain("以前の版は消えず");
    expect(html).toContain("「無効」の状態で作成できます");
    expect(html).not.toContain("新しいメモの作成はできません");
    expect(html).toContain("取引の例、例外、経理上の注意");
    expect(html).toContain("パスワードなどの秘密情報");
    expect(html).toContain("承認を省いたりする内容は書かないでください");
  });

  it("メモが0件のときは、失敗とは別の文言", async () => {
    loadNoteEditor.mockResolvedValue(data([]));
    const html = await render();
    expect(html).toContain("保存されているメモはありません");
    expect(html).toContain("「新しいメモを作る」から作成できます");
    expect(html).not.toContain(NOTE_LOAD_FAILED_MESSAGE);
  });

  it("新しいメモを作るリンクは、描画ごとに新しい依頼ID（UUID）をURLに固定する。顧客が読めないときは出さない", async () => {
    loadNoteEditor.mockResolvedValue(data());
    const hrefs = [await render(), await render()].map((h) => /href="(\/customers\/[^"]+\/notes\/new\?[^"]+)"/.exec(h)?.[1]);
    const ids = hrefs.map((h) => new URL(h ?? "", "http://x").searchParams.get("requestId"));
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(hrefs[0]).toContain(`/customers/${CID}/notes/new?requestId=`);

    loadNoteEditor.mockRejectedValue(new Error(SECRET));
    expect(await render()).not.toContain("/notes/new");
  });

  it("承認画面と顧客ルールの画面へ戻れる", async () => {
    loadNoteEditor.mockResolvedValue(data());
    const html = await render();
    expect(html).toContain(`href="/customers/${CID}"`);
    expect(html).toContain(`href="/customers/${CID}/rules"`);
  });
});
