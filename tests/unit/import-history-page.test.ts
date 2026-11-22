import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// モジュール単位の合成テスト（ブラウザ・実 DB は通らない）
const loadImportHistory = vi.fn();
const createUserClient = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createUserClient: () => createUserClient() }));
vi.mock("@/lib/statements/history", async (orig) => ({
  ...(await orig<typeof import("@/lib/statements/history")>()),
  loadImportHistory: (...a: unknown[]) => loadImportHistory(...a),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));

import ImportHistoryPage from "@/app/customers/[customerId]/imports/page";
import { MAX_DETAIL_ITEMS, type ImportHistory, type ImportRecord } from "@/lib/statements/history";

const CID = "11111111-1111-4111-8111-111111111111";
const SECRET = "sk-secret-INFRA-token zod issue at statement_imports.id";
const render = async (searchParams: { page?: string | string[] } = {}) =>
  renderToStaticMarkup(await ImportHistoryPage({ params: Promise.resolve({ customerId: CID }), searchParams: Promise.resolve(searchParams) }));

const ok = (items: { line: number; text: string }[] = [], omitted = 0) => ({ state: "ok" as const, items, total: items.length + omitted, omitted });
const rec = (o: Partial<ImportRecord> = {}): ImportRecord => ({
  importId: "imp-1",
  at: "2026-10-03T05:00:00Z",
  source: "csv",
  status: "completed",
  fileName: "oct.csv",
  csvFormat: "bank_generic",
  wallet: { id: "w-1", name: "普通預金" },
  importer: { id: "user-1", name: "担当A" },
  sourceRowCount: 5,
  counts: { read: 4, inserted: 2, skipped: 1, suspected: 1 },
  amounts: { income: 10000, expense: 3000, inserted: 8000, skipped: 2000, suspected: 3000 },
  ignored: ok([{ line: 5, text: "金額が0" }]),
  errors: ok(),
  warnings: [],
  ...o,
});
const failedRec = (o: Partial<ImportRecord> = {}) =>
  rec({
    status: "failed",
    fileName: "card.csv",
    csvFormat: "card_generic",
    sourceRowCount: 20,
    counts: { read: 0, inserted: 0, skipped: 0, suspected: 0 },
    amounts: { income: 0, expense: 0, inserted: 0, skipped: 0, suspected: 0 },
    ignored: ok(),
    errors: ok([{ line: 7, text: "日付を読めません" }]),
    ...o,
  });
const history = (rows: ImportRecord[], o: Partial<ImportHistory> = {}): ImportHistory => ({
  customer: { id: CID, name: "テスト商事" },
  page: 1,
  pageSize: 50,
  rows,
  hasPrevious: false,
  hasNext: false,
  olderBeyondLimit: false,
  ...o,
});

beforeEach(() => {
  loadImportHistory.mockReset();
  createUserClient.mockReset();
  createUserClient.mockResolvedValue({});
});

describe("取込の記録画面", () => {
  it("顧客IDとページ番号を読込に渡し、不正なページは1にする", async () => {
    loadImportHistory.mockResolvedValue(history([]));
    await render({ page: "3" });
    expect(loadImportHistory).toHaveBeenLastCalledWith({}, CID, 3);
    await render({ page: "abc" });
    expect(loadImportHistory).toHaveBeenLastCalledWith({}, CID, 1);
    await render({ page: ["2", "3"] });
    expect(loadImportHistory).toHaveBeenLastCalledWith({}, CID, 1);
  });

  it("顧客が見えない（null）ときは 404 にし、記録も顧客名も出さない", async () => {
    loadImportHistory.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("読込・クライアント作成の例外は固定の汎用文だけにし、中身を出さず、0件とも区別する", async () => {
    for (const fail of [() => loadImportHistory.mockRejectedValue(new Error(SECRET)), () => createUserClient.mockRejectedValue(new Error(SECRET))]) {
      loadImportHistory.mockReset();
      createUserClient.mockResolvedValue({});
      fail();
      const html = await render();
      for (const leak of ["sk-secret", "zod", "INFRA", "statement_imports"]) expect(html).not.toContain(leak);
      expect(html).toContain("取込の記録を読み込めなかったため");
      expect(html).not.toContain("まだ見つかりません");
      expect(html).not.toMatch(/<section/);
    }
  });

  it("1ページ目が0件でも『登録されていない証明ではない』と示し、2ページ目以降は範囲外の案内を出す（エラーではない）", async () => {
    loadImportHistory.mockResolvedValue(history([]));
    let html = await render();
    expect(html).toContain("取込の記録は、この画面ではまだ見つかりません");
    expect(html).toContain("取込が行われていないことの証明ではありません");
    expect(html).not.toContain("読み込めなかった");
    loadImportHistory.mockResolvedValue(history([], { page: 4, hasPrevious: true }));
    html = await render({ page: "4" });
    expect(html).toContain("このページに記録はありません");
    expect(html).toContain(`href="/customers/${CID}/imports"`);
  });

  it("成功: ファイル・口座・取込者・形式・元の行数・件数・金額・金額0の行を表示し、内訳が合計と一致して並ぶ", async () => {
    loadImportHistory.mockResolvedValue(history([rec()]));
    const html = await render();
    expect(html).toContain("テスト商事：明細CSVの取込の記録");
    expect(html).toContain("成功");
    expect(html).toContain("2026/10/3 14:00:00"); // JST
    expect(html).toContain("ファイル: oct.csv");
    expect(html).toContain("口座: 普通預金（ID w-1）");
    expect(html).toContain("取込者: 担当A（ID user-1）");
    expect(html).toContain("CSVの形式: 銀行（日付・摘要・出金・入金・残高）");
    expect(html).toContain("元のファイルの行数（見出し・空行を除く）: 5件");
    expect(html).toMatch(/<h2>成功/);
    expect(html).toContain("読めた行: 4件（入金 10,000円・出金 3,000円）");
    expect(html).toContain("登録: 2件 8,000円");
    expect(html).toContain("取込済みのため読み飛ばし: 1件 2,000円");
    expect(html).toContain("重複の疑い（人の確認待ちとして登録）: 1件 3,000円");
    expect(html).toContain("金額0のため取引にしなかった行（1 行）");
    expect(html).toContain("5行目: 金額が0");
    expect(html).toContain("取込ID imp-1");
    expect(html).not.toContain("矛盾があります");
  });

  it("失敗: 取り込んでいないこと、0は取込なしの意味で金額なしの証明ではないこと、元の金額合計は未計算であることを示し、0円を並べない", async () => {
    loadImportHistory.mockResolvedValue(history([failedRec()]));
    const html = await render();
    expect(html).toContain("失敗（取り込んでいません）");
    expect(html).toContain("このファイルは取り込んでいません");
    expect(html).toContain("元のファイルに金額がなかったことの証明ではありません");
    expect(html).toContain("元のファイルの金額合計は計算していません");
    expect(html).toContain("読めなかった行（1 行）");
    expect(html).toContain("7行目: 日付を読めません");
    expect(html).toContain("元のファイルの行数（見出し・空行を除く）: 20件");
    expect(html).not.toContain("0円");
    expect(html).not.toContain("読めた行:");
  });

  it("欠落した古い記録（ファイル名・形式・取込者・元の行数）は『記録なし』『不明』と示し、0 や空で補わない", async () => {
    loadImportHistory.mockResolvedValue(
      history([rec({ fileName: null, csvFormat: null, importer: { id: null, name: null }, sourceRowCount: null, ignored: ok() })]),
    );
    const html = await render();
    expect(html).toContain("ファイル: （記録なし）");
    expect(html).toContain("CSVの形式: （記録なし）");
    expect(html).toContain("取込者: （記録なし）");
    expect(html).toContain("元のファイルの行数（見出し・空行を除く）: 不明（記録されていません）");
    expect(html).not.toContain("元のファイルの行数（見出し・空行を除く）: 0件");
  });

  it("口座・取込者の名前が読めないときは明示して ID を出し、知らない形式は名前を引けないと示す", async () => {
    loadImportHistory.mockResolvedValue(
      history([rec({ wallet: { id: "w-9", name: null }, importer: { id: "user-9", name: null }, csvFormat: "future_fmt" })]),
    );
    const html = await render();
    expect(html).toContain("口座: （名前を読めません）（ID w-9）");
    expect(html).toContain("取込者: （名前を読めません）（ID user-9）");
    expect(html).toContain("future_fmt（この版では名前を引けない形式）");
  });

  it("照合の警告があるときは、成功の見た目にせず警告を出す", async () => {
    loadImportHistory.mockResolvedValue(history([rec({ warnings: ["件数が合いません: 読めた行 4 件に対し…"] })]));
    const html = await render();
    expect(html).toContain("読み取れた範囲で矛盾があります");
    expect(html).toContain("件数が合いません");
    expect(html).toContain("未解決として扱って");
    // 見出しは成功にせず、記録上の状態は別に示す
    expect(html).toMatch(/<h2>要確認（記録に不整合）/);
    expect(html).not.toMatch(/<h2>成功/);
    expect(html).toContain("記録上の状態: 成功");
  });

  it("失敗の記録に警告があるときも、見出しは要確認にし、記録上の状態は失敗と示す", async () => {
    loadImportHistory.mockResolvedValue(history([failedRec({ warnings: ["失敗の記録なのに、金額が 0 ではありません"] })]));
    const html = await render();
    expect(html).toMatch(/<h2>要確認（記録に不整合）/);
    expect(html).not.toMatch(/<h2>(成功|失敗)/);
    expect(html).toContain("記録上の状態: 失敗");
  });

  it("行番号 0 はファイル全体の誤りとして示し、0行目とは書かない", async () => {
    loadImportHistory.mockResolvedValue(
      history([failedRec({ errors: ok([{ line: 0, text: "見出しがありません" }, { line: 7, text: "日付を読めません" }]) })]),
    );
    const html = await render();
    expect(html).toContain("ファイル全体: 見出しがありません");
    expect(html).not.toContain("0行目");
    expect(html).toContain("7行目: 日付を読めません");
  });

  it("形式が不正な金額0の行・読めなかった行は『なし』ではなく表示できないと示す", async () => {
    loadImportHistory.mockResolvedValue(history([rec({ ignored: { state: "invalid" }, errors: { state: "invalid" } })]));
    const html = await render();
    expect(html).toContain("金額0のため取引にしなかった行: 記録の形式が不正で表示できません");
    expect(html).toContain("読めなかった行: 記録の形式が不正で表示できません");
  });

  it("大量の行は省略件数を明示する", async () => {
    const items = Array.from({ length: MAX_DETAIL_ITEMS }, (_, i) => ({ line: i + 2, text: "金額が0" }));
    loadImportHistory.mockResolvedValue(history([rec({ ignored: ok(items, 250) })]));
    const html = await render();
    expect(html).toContain("金額0のため取引にしなかった行（350 行）");
    expect(html).toContain("ほか 250 行は省略しました");
    expect(html.match(/行目: 金額が0/g)).toHaveLength(MAX_DETAIL_ITEMS);
  });

  it("説明: 記録なしは未登録の証明ではない・件数は不変・承認や freee 登録ではない・自動再送しない", async () => {
    loadImportHistory.mockResolvedValue(history([rec()]));
    const html = await render();
    expect(html).toContain("記録が見つからないことは「登録されていない」ことの証明ではありません");
    expect(html).toContain("重複の疑い」を解決しても変わりません");
    expect(html).toContain("承認ではなく、freee への登録が済んだことも示しません");
    expect(html).toContain("自動では再送しません");
    expect(html).not.toMatch(/freee に登録済み|登録しました|承認済み/);
  });

  it("外部由来の文字列（ファイル名・口座名・取込者名・行の理由・顧客名）は HTML としてエスケープされる", async () => {
    const evil = `<img src=x onerror=alert(1)>`;
    loadImportHistory.mockResolvedValue(
      history(
        [
          rec({
            fileName: evil,
            wallet: { id: "w", name: evil },
            importer: { id: "u", name: evil },
            ignored: ok([{ line: 2, text: `<script>alert(1)</script>` }]),
            errors: ok([{ line: 3, text: evil }]),
          }),
        ],
        { customer: { id: CID, name: evil } },
      ),
    );
    const html = await render();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("ページ送り: 次へ・前へは page クエリだけで、1ページ目の前へは出さず、最終ページの次へも出さない", async () => {
    loadImportHistory.mockResolvedValue(history([rec()], { hasNext: true }));
    let html = await render();
    expect(html).toContain(`href="/customers/${CID}/imports?page=2"`);
    expect(html).not.toContain("前のページ");
    loadImportHistory.mockResolvedValue(history([rec()], { page: 2, hasPrevious: true, hasNext: true }));
    html = await render({ page: "2" });
    expect(html).toContain(`href="/customers/${CID}/imports?page=3"`);
    expect(html).toContain(`href="/customers/${CID}/imports"`);
    loadImportHistory.mockResolvedValue(history([rec()], { page: 3, hasPrevious: true }));
    html = await render({ page: "3" });
    expect(html).not.toContain("次のページ");
  });

  it("表示できる最終ページでは次へのリンクを出さず、より古い記録が辿れない旨を明示する。通常ページでは出さない", async () => {
    loadImportHistory.mockResolvedValue(history([rec()], { page: 10000, hasPrevious: true, olderBeyondLimit: true }));
    let html = await render({ page: "10000" });
    expect(html).not.toContain("次のページ");
    expect(html).not.toContain("page=10001");
    expect(html).toContain(`href="/customers/${CID}/imports?page=9999"`);
    expect(html).toContain("これより古い記録があります");
    loadImportHistory.mockResolvedValue(history([rec()], { hasNext: true }));
    html = await render();
    expect(html).not.toContain("これより古い記録があります");
  });

  it("書込・取込の操作を出さない（ボタン・フォーム・入力なし）", async () => {
    loadImportHistory.mockResolvedValue(history([rec(), failedRec({ importId: "imp-2" })], { hasNext: true }));
    const html = await render();
    expect(html).not.toMatch(/<(button|form|input|select|textarea)\b/);
    expect(html).toContain("読み取り専用");
  });
});
