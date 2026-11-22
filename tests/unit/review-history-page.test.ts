import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// モジュール単位の合成テスト（ブラウザ・実 DB は通らない）
const loadReviewHistory = vi.fn();
const createUserClient = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createUserClient: () => createUserClient() }));
vi.mock("@/lib/review/history", async (orig) => ({
  ...(await orig<typeof import("@/lib/review/history")>()),
  loadReviewHistory: (...a: unknown[]) => loadReviewHistory(...a),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));

import ReviewHistoryPage from "@/app/customers/[customerId]/history/page";
import { masterKey, type HistoryRow, type ReviewHistory } from "@/lib/review/history";

const CID = "11111111-1111-4111-8111-111111111111";
const SECRET = "sk-secret-INFRA-token zod issue at human_reviews.id";
const render = async (searchParams: { page?: string | string[] } = {}) =>
  renderToStaticMarkup(await ReviewHistoryPage({ params: Promise.resolve({ customerId: CID }), searchParams: Promise.resolve(searchParams) }));

const entry = (o: Record<string, unknown> = {}) => ({
  account_item_id: 100,
  tax_code: 1,
  partner_id: null,
  item_id: null,
  section_id: null,
  tag_ids: [],
  description: "文具",
  ...o,
});
const row = (o: Partial<HistoryRow> = {}): HistoryRow => ({
  reviewId: "rev-1",
  action: "approve",
  at: "2026-10-01T03:00:00Z",
  bulk: false,
  reviewer: { id: "user-1", name: "管理者A" },
  reason: null,
  decisionId: "dec-1",
  txn: { id: "txn-1", date: "2026-10-01", amount: 12000, direction: "expense", description: "ACME 文具" },
  proposal: { state: "ok", entry: entry() },
  finalEntry: entry(),
  diff: [],
  ...o,
});
const masters = new Map([
  [masterKey("account_item", 100), { name: "消耗品費", available: true }],
  [masterKey("account_item", 200), { name: "旧通信費", available: false }],
  [masterKey("tax", 1), { name: "課対仕入10%", available: true }],
  [masterKey("partner", 7), { name: "ACME商事", available: true }],
]);
const history = (rows: HistoryRow[], o: Partial<ReviewHistory> = {}): ReviewHistory => ({
  customer: { id: CID, name: "テスト商事" },
  page: 1,
  pageSize: 50,
  rows,
  hasPrevious: false,
  hasNext: false,
  olderBeyondLimit: false,
  masters,
  ...o,
});

beforeEach(() => {
  loadReviewHistory.mockReset();
  createUserClient.mockReset();
  createUserClient.mockResolvedValue({});
});

describe("確認の履歴画面", () => {
  it("顧客IDとページ番号を読込に渡し、不正なページは1にする", async () => {
    loadReviewHistory.mockResolvedValue(history([]));
    await render({ page: "3" });
    expect(loadReviewHistory).toHaveBeenLastCalledWith({}, CID, 3);
    await render({ page: "abc" });
    expect(loadReviewHistory).toHaveBeenLastCalledWith({}, CID, 1);
    await render({ page: ["2", "3"] });
    expect(loadReviewHistory).toHaveBeenLastCalledWith({}, CID, 1);
  });

  it("顧客が見えない（null）ときは 404 にし、履歴も顧客名も出さない", async () => {
    loadReviewHistory.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("読込・クライアント作成の例外は固定の汎用文だけにし、中身を出さず、0件とも区別する", async () => {
    for (const fail of [() => loadReviewHistory.mockRejectedValue(new Error(SECRET)), () => createUserClient.mockRejectedValue(new Error(SECRET))]) {
      loadReviewHistory.mockReset();
      createUserClient.mockResolvedValue({});
      fail();
      const html = await render();
      for (const leak of ["sk-secret", "zod", "INFRA", "human_reviews"]) expect(html).not.toContain(leak);
      expect(html).toContain("確認の履歴を読み込めなかったため");
      expect(html).not.toContain("まだありません");
      expect(html).not.toMatch(/<table/);
    }
  });

  it("1ページ目が0件なら『まだありません』、2ページ目以降が0件なら範囲外の案内を出す（エラーではない）", async () => {
    loadReviewHistory.mockResolvedValue(history([]));
    let html = await render();
    expect(html).toContain("確認の記録はまだありません");
    expect(html).not.toContain("読み込めなかった");
    loadReviewHistory.mockResolvedValue(history([], { page: 4, hasPrevious: true }));
    html = await render({ page: "4" });
    expect(html).toContain("このページに記録はありません");
    expect(html).toContain(`href="/customers/${CID}/history"`);
    expect(html).not.toContain("まだありません");
  });

  it("承認: 取引・確認者・日時・ID・変更前と確定内容を名前つきで表示し、freee 登録とは区別する", async () => {
    loadReviewHistory.mockResolvedValue(history([row()]));
    const html = await render();
    expect(html).toContain("テスト商事：確認の履歴");
    expect(html).toContain("承認");
    expect(html).toContain("2026/10/1 12:00:00"); // JST
    expect(html).toContain("取引: 2026-10-01、12,000円（出金）、ACME 文具");
    expect(html).toContain("確認者: 管理者A（ID user-1）");
    expect(html).toContain("消耗品費（ID 100）");
    expect(html).toContain("課対仕入10%（ID 1）");
    expect(html).toContain("変更前の仕訳候補");
    expect(html).toContain("確定内容");
    expect(html).toContain("確認ID rev-1 / 判断ID dec-1 / 明細ID txn-1");
    expect(html).toContain("freee への登録が済んだことを示すものではなく");
    expect(html).toContain("理由: （記載なし）");
    expect(html).not.toMatch(/freee に登録済み|登録しました/);
  });

  it("修正: 差分を前→後で、無効なマスタ・名前のないIDも明示して表示する", async () => {
    loadReviewHistory.mockResolvedValue(
      history([
        row({
          action: "correct",
          reason: "科目の誤り",
          proposal: { state: "ok", entry: entry() },
          finalEntry: entry({ account_item_id: 200, partner_id: 7, tag_ids: [55] }),
          diff: [
            { field: "account_item_id", before: 100, after: 200 },
            { field: "partner_id", before: null, after: 7 },
            { field: "tag_ids", before: [], after: [55] },
            { field: "unknown_field", before: 1, after: 2 },
          ],
        }),
      ]),
    );
    const html = await render();
    expect(html).toContain("修正して承認");
    expect(html).toContain("理由: 科目の誤り");
    expect(html).toContain("勘定科目: 消耗品費（ID 100） → 旧通信費（ID 200、現在は無効）");
    expect(html).toContain("取引先: なし → ACME商事（ID 7）");
    expect(html).toContain("メモタグ: なし → ID 55（マスタに名前がありません）");
    expect(html).toContain("項目 unknown_field: （記録なし） → （記録なし）");
  });

  it("保留・却下: 理由と確認者を出し、仕訳候補の表は出さない。まとめて承認も明示する", async () => {
    loadReviewHistory.mockResolvedValue(
      history([
        row({ reviewId: "h1", action: "hold", reason: "領収書待ち", finalEntry: null, reviewer: { id: "user-2", name: null } }),
        row({ reviewId: "x1", action: "reject", reason: null, finalEntry: null }),
        row({ reviewId: "b1", bulk: true }),
      ]),
    );
    const html = await render();
    expect(html).toContain("保留");
    expect(html).toContain("却下");
    expect(html).toContain("理由: 領収書待ち");
    expect(html).toContain("確認者: 担当者（ID user-2）"); // 名前を読めないときの既定
    expect(html).toContain("、まとめて承認");
    expect(html.match(/<table/g)).toHaveLength(1); // 承認の1件だけ
    expect(html).not.toContain("修正した項目");
  });

  it("関連データの欠落を明示し、履歴の行は残す（明細・判断・確定内容・提案なし）", async () => {
    loadReviewHistory.mockResolvedValue(
      history([
        row({ reviewId: "m1", txn: null, proposal: { state: "unavailable" }, finalEntry: null }),
        row({ reviewId: "m2", proposal: { state: "none" }, action: "correct", diff: [] }),
      ]),
    );
    const html = await render();
    expect(html).toContain("この確認の明細を表示できません");
    expect(html).toContain("変更前の仕訳候補を表示できません（判断ID dec-1");
    expect(html).toContain("確定内容を表示できません");
    expect(html).toContain("変更前の仕訳候補はありません（AI は提案を返していません）");
    expect(html).toContain("差分の記録がありません");
    expect(html).toContain("表示できません");
    expect(html).not.toContain("明細ID undefined");
    expect(html.match(/確認ID /g)).toHaveLength(2);
  });

  it("外部由来の文字列（摘要・理由・名前・マスタ名）は HTML としてエスケープされる", async () => {
    const evil = `<img src=x onerror=alert(1)>`;
    loadReviewHistory.mockResolvedValue(
      history(
        [
          row({
            reason: evil,
            reviewer: { id: "u", name: evil },
            txn: { id: "t", date: "2026-10-01", amount: 1, direction: "income", description: evil },
            finalEntry: entry({ description: evil }),
            proposal: { state: "ok", entry: entry({ description: `<script>alert(1)</script>` }) },
          }),
        ],
        { customer: { id: CID, name: evil } },
      ),
    );
    const html = await render();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("値の形が想定外でも例外にせず『表示できない形式』にする", async () => {
    loadReviewHistory.mockResolvedValue(
      history([row({ finalEntry: entry({ account_item_id: "abc", tag_ids: [{}], description: 5 }), proposal: { state: "ok", entry: {} } })]),
    );
    const html = await render();
    expect(html).toContain("表示できない形式");
    expect(html).toContain("（記録なし）");
  });

  it("ページ送り: 次へ・前へは page クエリだけで、1ページ目の前へは出さず、最終ページの次へも出さない", async () => {
    loadReviewHistory.mockResolvedValue(history([row()], { hasNext: true }));
    let html = await render();
    expect(html).toContain(`href="/customers/${CID}/history?page=2"`);
    expect(html).not.toContain("前のページ");
    loadReviewHistory.mockResolvedValue(history([row()], { page: 2, hasPrevious: true, hasNext: true }));
    html = await render({ page: "2" });
    expect(html).toContain(`href="/customers/${CID}/history?page=3"`);
    expect(html).toContain(`href="/customers/${CID}/history"`); // 2ページ目の前へ＝1ページ目（page なし）
    loadReviewHistory.mockResolvedValue(history([row()], { page: 3, hasPrevious: true, hasNext: false }));
    html = await render({ page: "3" });
    expect(html).toContain(`href="/customers/${CID}/history?page=2"`);
    expect(html).not.toContain("次のページ");
  });

  it("表示できる最終ページでは次へのリンクを出さず、より古い記録が辿れない旨を明示する", async () => {
    loadReviewHistory.mockResolvedValue(history([row()], { page: 10000, hasPrevious: true, hasNext: false, olderBeyondLimit: true }));
    let html = await render({ page: "10000" });
    expect(html).not.toContain("次のページ");
    expect(html).not.toContain("page=10001");
    expect(html).toContain(`href="/customers/${CID}/history?page=9999"`);
    expect(html).toContain("これより古い記録があります");
    // 通常のページでは出さない
    loadReviewHistory.mockResolvedValue(history([row()], { hasNext: true }));
    html = await render();
    expect(html).not.toContain("これより古い記録があります");
  });

  it("書込・検索の操作を出さない（ボタン・フォーム・入力なし）", async () => {
    loadReviewHistory.mockResolvedValue(
      history([row(), row({ reviewId: "c", action: "correct", diff: [{ field: "tax_code", before: 1, after: 2 }] })], { hasNext: true }),
    );
    const html = await render();
    expect(html).not.toMatch(/<(button|form|input|select|textarea)\b/);
    expect(html).toContain("読み取り専用");
  });
});
