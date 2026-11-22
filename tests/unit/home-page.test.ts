import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// モジュール単位の合成テスト（ブラウザ・実 DB は通らない）
const fetchAll = vi.fn();
const loadPendingCounts = vi.fn();
const createUserClient = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createUserClient: () => createUserClient() }));
vi.mock("@/lib/supabase/fetch-all", () => ({ fetchAll: (...a: unknown[]) => fetchAll(...a) }));
vi.mock("@/lib/review/counts", () => ({
  PENDING_STATUSES: ["proposed", "on_hold", "duplicate_suspected", "new"],
  loadPendingCounts: (...a: unknown[]) => loadPendingCounts(...a),
}));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));

import HomePage from "@/app/page";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SECRET = "sk-secret-INFRA-token zod issue at pending_transaction_counts 秘密商事";
const render = async () => renderToStaticMarkup(await HomePage());

const SAFE = "顧客一覧または確認待ち件数を読み込めなかったため表示できません";
const EMPTY = "担当している顧客がありません。";

const counts = (m: Record<string, number>) => ({ get: (id: string, s: string) => m[`${id}:${s}`] ?? 0 });

beforeEach(() => {
  fetchAll.mockReset();
  loadPendingCounts.mockReset();
  createUserClient.mockReset();
  createUserClient.mockResolvedValue({});
  fetchAll.mockResolvedValue([]);
  loadPendingCounts.mockResolvedValue(counts({}));
});

function expectSafeFailure(html: string) {
  expect(html).toContain(SAFE);
  expect(html).toContain("ことを意味しません");
  for (const leak of ["sk-secret", "INFRA", "zod", "pending_transaction_counts", "秘密商事", "NONERROR", "テスト商事"]) {
    expect(html).not.toContain(leak);
  }
  // 誤解を招く表示を出さない: 「顧客なし」・件数・表・顧客リンク
  expect(html).not.toContain(EMPTY);
  expect(html).not.toContain("<table");
  expect(html).not.toContain("<td");
  expect(html).not.toContain("—");
  expect(html).not.toContain("/customers/");
}

describe("トップ画面（読込失敗の扱い）", () => {
  const failures: [string, () => void][] = [
    ["クライアント作成の失敗", () => createUserClient.mockRejectedValue(new Error(SECRET))],
    ["顧客取得の失敗", () => fetchAll.mockRejectedValue(new Error(SECRET))],
    ["件数取得の失敗", () => {
      fetchAll.mockResolvedValue([{ id: A, name: "テスト商事" }]);
      loadPendingCounts.mockRejectedValue(new Error(SECRET));
    }],
    ["応答の形が不正（スキーマ検証の失敗）", () => fetchAll.mockResolvedValue([{ id: 1, name: "テスト商事 秘密商事" }])],
    ["Error ではない値の throw", () => fetchAll.mockImplementation(() => Promise.reject("sk-secret-NONERROR 秘密商事"))],
  ];

  for (const [name, arrange] of failures) {
    it(`${name}: 固定文言のみで、例外・顧客データ・件数・リンク・「顧客なし」を出さない`, async () => {
      arrange();
      expectSafeFailure(await render());
    });
  }

  it("クライアント作成が失敗したら、顧客・件数の取得を始めない", async () => {
    createUserClient.mockRejectedValue(new Error(SECRET));
    await render();
    expect(fetchAll).not.toHaveBeenCalled();
    expect(loadPendingCounts).not.toHaveBeenCalled();
  });
});

describe("トップ画面（正常・真に空）", () => {
  it("顧客名・リンク・件数（0 を含む）を従来どおり描画し、エラー文と「顧客なし」は出さない", async () => {
    fetchAll.mockResolvedValue([
      { id: A, name: "甲商事" },
      { id: B, name: "乙商事" },
    ]);
    loadPendingCounts.mockResolvedValue(counts({ [`${A}:proposed`]: 3, [`${A}:new`]: 12, [`${A}:on_hold`]: 1 }));
    const html = await render();
    expect(html).toContain(`<a href="/customers/${A}">甲商事</a>`);
    expect(html).toContain(`<a href="/customers/${B}">乙商事</a>`);
    // 甲: 確認待ち3・保留1・重複の疑い0・未判定12 / 乙: すべて 0
    expect(html).toContain('<td class="num">3</td><td class="num">1</td><td class="num">0</td><td class="num">12</td>');
    expect(html).toContain('<td class="num">0</td><td class="num">0</td><td class="num">0</td><td class="num">0</td>');
    expect(html).not.toContain("読み込めなかった");
    expect(html).not.toContain(EMPTY);
    expect(html).not.toContain("—");
    expect(loadPendingCounts).toHaveBeenCalledWith({});
  });

  it("真に空（顧客 0 件）では「担当している顧客がありません。」を出し、エラー文は出さない", async () => {
    const html = await render();
    expect(html).toContain(EMPTY);
    expect(html).toContain("<table");
    expect(html).not.toContain("読み込めなかった");
  });
});
