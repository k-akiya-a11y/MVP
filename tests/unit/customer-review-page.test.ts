import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// モジュール単位の合成テスト（ブラウザ・実 DB は通らない）
const loadReviewQueue = vi.fn();
const createUserClient = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createUserClient: () => createUserClient() }));
vi.mock("@/lib/review/queue", () => ({ loadReviewQueue: (...a: unknown[]) => loadReviewQueue(...a) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));
// 操作コンポーネントは目印だけにして、失敗時に描画されないことを確かめる
vi.mock("@/app/customers/[customerId]/upload-form", () => ({ UploadForm: () => createElement("div", { "data-c": "upload-form" }) }));
vi.mock("@/app/customers/[customerId]/review-board", () => ({ ReviewBoard: () => createElement("div", { "data-c": "review-board" }) }));
vi.mock("@/app/customers/[customerId]/duplicates-panel", () => ({
  DuplicatesPanel: () => createElement("div", { "data-c": "duplicates-panel" }),
}));

import CustomerReviewPage from "@/app/customers/[customerId]/page";

const CID = "11111111-1111-4111-8111-111111111111";
const SECRET = "sk-secret-INFRA-token zod issue at bank_transactions.id 秘密商事";
const render = async () => renderToStaticMarkup(await CustomerReviewPage({ params: Promise.resolve({ customerId: CID }) }));

const queue = () => ({
  customer: { id: CID, name: "テスト商事" },
  wallets: [],
  canApprove: true,
  suspectedDuplicates: [],
  items: [],
  masters: {},
});

beforeEach(() => {
  loadReviewQueue.mockReset();
  createUserClient.mockReset();
  createUserClient.mockResolvedValue({});
});

describe("顧客の承認画面（読込失敗の扱い）", () => {
  it("顧客が見えない（null）ときは 404 にする", async () => {
    loadReviewQueue.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("読込・クライアント作成の例外は 404 にせず、固定の読み取り専用エラーを出す（null と区別）", async () => {
    for (const fail of [() => loadReviewQueue.mockRejectedValue(new Error(SECRET)), () => createUserClient.mockRejectedValue(new Error(SECRET))]) {
      loadReviewQueue.mockReset();
      createUserClient.mockResolvedValue({});
      fail();
      const html = await render(); // NEXT_NOT_FOUND は投げない
      expect(html).toContain("承認待ちの取引を読み込めなかったため表示できません");
      expect(html).toContain("「承認待ちがない」ことを意味しません");
    }
  });

  it("失敗時は例外の中身・顧客データを出さず、操作コンポーネントも描画しない", async () => {
    loadReviewQueue.mockRejectedValue(new Error(SECRET));
    const html = await render();
    for (const leak of ["sk-secret", "zod", "INFRA", "bank_transactions", "秘密商事", "テスト商事"]) expect(html).not.toContain(leak);
    for (const c of ["upload-form", "review-board", "duplicates-panel"]) expect(html).not.toContain(`data-c="${c}"`);
    expect(html).not.toMatch(/<(button|form|input|select|textarea)\b/);
    expect(html).not.toContain("承認待ちはありません");
  });

  it("正常なキューでは従来どおり顧客名・リンク・操作コンポーネントを描画する", async () => {
    loadReviewQueue.mockResolvedValue(queue());
    const html = await render();
    expect(loadReviewQueue).toHaveBeenCalledWith({}, CID);
    expect(html).toContain("テスト商事");
    for (const path of ["history", "imports", "statements", "past-quality", "rules", "notes"]) {
      expect(html).toContain(`href="/customers/${CID}/${path}"`);
    }
    expect(html).toContain('href="/"');
    for (const c of ["upload-form", "review-board", "duplicates-panel"]) expect(html).toContain(`data-c="${c}"`);
    expect(html).not.toContain("読み込めなかった");
  });
});
