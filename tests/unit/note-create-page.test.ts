import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// モジュール単位の合成テスト（ブラウザ・実 DB は通らない。入力・クリックなどの操作は未確認）
const loadNoteCreateSource = vi.fn();
const createUserClient = vi.fn();
const createCustomerNoteAction = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createUserClient: () => createUserClient() }));
vi.mock("@/lib/notes/create-load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notes/create-load")>()),
  loadNoteCreateSource: (...a: unknown[]) => loadNoteCreateSource(...a),
}));
vi.mock("@/app/customers/[customerId]/notes/new/actions", () => ({
  createCustomerNoteAction: (...a: unknown[]) => createCustomerNoteAction(...a),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));

import NewNotePage from "@/app/customers/[customerId]/notes/new/page";
import { NOTE_CREATE_LOAD_FAILED_MESSAGE } from "@/lib/notes/create-load";
import { CID, NID, SECRET } from "../fixtures/note-editor";

type Search = Record<string, string | string[] | undefined>;
const render = async (search: Search = { requestId: NID }) =>
  renderToStaticMarkup(await NewNotePage({ params: Promise.resolve({ customerId: CID }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  loadNoteCreateSource.mockReset();
  createUserClient.mockReset();
  createCustomerNoteAction.mockReset();
  createUserClient.mockResolvedValue({});
  loadNoteCreateSource.mockResolvedValue({ id: CID, name: "テスト商事" });
});

describe("新規メモ画面", () => {
  it("開いただけでは保存せず、タイトル・本文は空欄で、無効で保存する明確なボタンが1つだけある", async () => {
    const html = await render();
    expect(html).toContain("テスト商事：新しい文章メモを作る");
    expect(html).toContain("無効で保存（AIにはまだ使わない）");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("有効として");
    expect(html).toContain(`<code>${NID}</code>`);
    expect(html).toMatch(/<input type="text" value=""/);
    expect(html).toMatch(/<textarea[^>]*>\s*<\/textarea>/);
    // 保存は押すまで呼ばれず、確認が取れるまでボタンは無効
    expect(createCustomerNoteAction).not.toHaveBeenCalled();
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>無効で保存/);
  });

  it("無効のまま AI にはまだ使われないこと、有効化は人が後から行うこと、書いてよい内容・いけない内容を説明する", async () => {
    const html = await render();
    expect(html).toContain("AI にはまだ使われません");
    expect(html).toContain("人が内容を確認して「有効」の新しい版として保存します");
    expect(html).toContain("命令ではなく");
    expect(html).toContain("パスワードなどの秘密情報");
    expect(html).toContain("1回だけ");
  });

  it("依頼ID（URL）の形式が不正・欠落・配列・余計なキーのときは、フォームを出さず、入力値も表示しない", async () => {
    const evil = `<script>alert(1)</script>`;
    for (const search of [{}, { requestId: "x" }, { requestId: evil }, { requestId: [NID, NID] }, { requestId: NID, status: "active" }]) {
      const html = await render(search);
      expect(html, JSON.stringify(search)).toContain("依頼IDの指定が正しくない");
      expect(html).not.toContain("<form");
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("無効で保存");
    }
    expect(createCustomerNoteAction).not.toHaveBeenCalled();
  });

  it("顧客が見えない（null）ときは notFound。読込・クライアント作成の例外は固定の失敗文だけでフォームも出さない", async () => {
    loadNoteCreateSource.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");

    loadNoteCreateSource.mockRejectedValue(new Error(SECRET));
    let html = await render();
    expect(html).toContain(NOTE_CREATE_LOAD_FAILED_MESSAGE);
    expect(html).not.toContain("sk-secret");
    expect(html).not.toContain("<form");

    createUserClient.mockRejectedValue(new Error(SECRET));
    html = await render();
    expect(html).toContain(NOTE_CREATE_LOAD_FAILED_MESSAGE);
    expect(html).not.toContain("sk-secret");
    expect(createCustomerNoteAction).not.toHaveBeenCalled();
  });

  it("一覧へ戻るリンクがある。ページ自体は保存の呼出しをしない", async () => {
    const html = await render();
    expect(html).toContain(`href="/customers/${CID}/notes"`);
    expect(createCustomerNoteAction).not.toHaveBeenCalled();
  });
});
