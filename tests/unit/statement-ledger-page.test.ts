import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// モジュール単位の合成テスト（ブラウザ・実 DB は通らない）
const loadLedger = vi.fn();
const createUserClient = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createUserClient: () => createUserClient() }));
vi.mock("@/lib/statements/ledger", async (orig) => ({
  ...(await orig<typeof import("@/lib/statements/ledger")>()),
  loadLedger: (...a: unknown[]) => loadLedger(...a),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href, "data-next-link": "true" }, p.children as never),
}));

import StatementLedgerPage from "@/app/customers/[customerId]/statements/page";
import { NO_FILTERS, TXN_STATUSES, TXN_STATUS_LABEL, type Ledger, type LedgerRow } from "@/lib/statements/ledger";

const CID = "11111111-1111-4111-8111-111111111111";
const W1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECRET = "sk-secret-INFRA-token zod issue at bank_transactions.id";
type SP = { page?: string | string[]; status?: string | string[]; wallet?: string | string[]; from?: string | string[]; to?: string | string[] };
const render = async (searchParams: SP = {}) =>
  renderToStaticMarkup(await StatementLedgerPage({ params: Promise.resolve({ customerId: CID }), searchParams: Promise.resolve(searchParams) }));

const row = (o: Partial<LedgerRow> = {}): LedgerRow => ({
  id: "txn-1",
  date: "2026-10-03",
  direction: "expense",
  amount: 3000,
  description: "ＡＢＣ商店",
  status: "new",
  importId: "imp-1",
  duplicateOfId: null,
  wallet: { id: "w-1", name: "普通預金" },
  ...o,
});
const ledger = (rows: LedgerRow[], o: Partial<Ledger> = {}): Ledger => ({
  customer: { id: CID, name: "テスト商事" },
  filters: NO_FILTERS,
  walletOptions: [{ id: W1, name: "普通預金" }],
  walletOptionsTruncated: false,
  walletUnavailable: false,
  page: 1,
  pageSize: 50,
  rows,
  hasPrevious: false,
  hasNext: false,
  olderBeyondLimit: false,
  ...o,
});

beforeEach(() => {
  loadLedger.mockReset();
  createUserClient.mockReset();
  createUserClient.mockResolvedValue({});
});

describe("明細一覧画面", () => {
  it("顧客IDとページ番号を読込に渡し、不正なページは1にする", async () => {
    loadLedger.mockResolvedValue(ledger([]));
    await render({ page: "3" });
    expect(loadLedger).toHaveBeenLastCalledWith({}, CID, 3, NO_FILTERS);
    await render({ page: "abc" });
    expect(loadLedger).toHaveBeenLastCalledWith({}, CID, 1, NO_FILTERS);
    await render({ page: "0" });
    expect(loadLedger).toHaveBeenLastCalledWith({}, CID, 1, NO_FILTERS);
    await render({ page: ["2", "3"] });
    expect(loadLedger).toHaveBeenLastCalledWith({}, CID, 1, NO_FILTERS);
  });

  it("顧客が見えない（null）ときは 404 にし、明細も顧客名も出さない", async () => {
    loadLedger.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("読込・クライアント作成の例外は固定の汎用文だけにし、中身を出さず、0件とも区別する", async () => {
    for (const fail of [() => loadLedger.mockRejectedValue(new Error(SECRET)), () => createUserClient.mockRejectedValue(new Error(SECRET))]) {
      loadLedger.mockReset();
      createUserClient.mockResolvedValue({});
      fail();
      const html = await render();
      for (const leak of ["sk-secret", "zod", "INFRA", "bank_transactions"]) expect(html).not.toContain(leak);
      expect(html).toContain("明細を読み込めなかったため");
      expect(html).not.toContain("まだ見つかりません");
      expect(html).not.toMatch(/<section/);
    }
  });

  it("1ページ目が0件でも『取り込まれていない証明ではない』と示し、2ページ目以降は範囲外の案内（エラーではない）", async () => {
    loadLedger.mockResolvedValue(ledger([]));
    let html = await render();
    expect(html).toContain("明細は、この画面ではまだ見つかりません");
    expect(html).toContain("取り込まれていないことの証明ではありません");
    expect(html).not.toContain("読み込めなかった");
    loadLedger.mockResolvedValue(ledger([], { page: 4, hasPrevious: true }));
    html = await render({ page: "4" });
    expect(html).toContain("このページに明細はありません");
    expect(html).toContain(`href="/customers/${CID}/statements"`);
    expect(html).not.toContain("読み込めなかった");
  });

  it("未判定・承認済み・重複の行を、日付・入出金・金額・摘要・口座・状態・ID つきで表示する", async () => {
    loadLedger.mockResolvedValue(
      ledger([
        row({ id: "txn-a", status: "new" }),
        row({ id: "txn-b", status: "approved", direction: "income", amount: 10000, description: "売上入金" }),
        row({ id: "txn-c", status: "duplicate", date: "2026-10-02", amount: 500 }),
      ]),
    );
    const html = await render();
    expect(html).toContain("テスト商事：取り込んだ明細の一覧");
    expect(html).toContain("2026-10-03");
    expect(html).toContain("出金 3,000円");
    expect(html).toContain("入金 10,000円");
    expect(html).toContain("出金 500円");
    expect(html).toContain("摘要: ＡＢＣ商店");
    expect(html).toContain("口座: 普通預金（ID w-1）");
    expect(html).toContain(`状態: ${TXN_STATUS_LABEL.new}`);
    expect(html).toContain(`状態: ${TXN_STATUS_LABEL.approved}`);
    expect(html).toContain(`状態: ${TXN_STATUS_LABEL.duplicate}`);
    expect(html).toContain("明細ID txn-a / 取込ID imp-1");
    // 表示順は読込の順のまま
    expect(html.indexOf("txn-a")).toBeLessThan(html.indexOf("txn-b"));
    expect(html.indexOf("txn-b")).toBeLessThan(html.indexOf("txn-c"));
  });

  it("全ての状態が日本語で出る（英語の状態名や undefined を出さない）", async () => {
    loadLedger.mockResolvedValue(ledger(TXN_STATUSES.map((s, i) => row({ id: `txn-${i}`, status: s, duplicateOfId: s === "duplicate_suspected" ? "txn-orig" : null }))));
    const html = await render();
    for (const s of TXN_STATUSES) expect(html).toContain(`状態: ${TXN_STATUS_LABEL[s]}`);
    expect(html).not.toContain("undefined");
    for (const s of TXN_STATUSES) expect(html).not.toContain(`状態: ${s}`);
    expect(html).toContain("重複の疑いの元の明細ID: txn-orig");
  });

  it("承認と freee 登録を区別し、未判定を失敗・AIの理由と書かず、登録済みを偽らない", async () => {
    loadLedger.mockResolvedValue(ledger([row({ status: "approved" }), row({ id: "txn-2", status: "new" })]));
    const html = await render();
    expect(html).toContain("freee への登録が済んだことは示しません");
    expect(html).toContain("判定に失敗した・不可という意味ではありません");
    expect(html).toContain("freee への登録は、この記録では確認できていません");
    expect(html).not.toMatch(/AI.{0,10}(理由|エラー)|エラー理由|判定できませんでした/);
    // 登録済みの文言は registered の行がないと出ない（approved/new だけの画面で「登録済み（記録上）」を出さない）
    expect(html).not.toContain(`状態: ${TXN_STATUS_LABEL.registered}`);
  });

  it("口座名が読めない行は明示して ID を出し、空の摘要は（空）と示す", async () => {
    loadLedger.mockResolvedValue(ledger([row({ wallet: { id: "w-9", name: null }, description: "" })]));
    const html = await render();
    expect(html).toContain("口座: （名前を読めません）（ID w-9）");
    expect(html).toContain("摘要: （空）");
  });

  it("並びの説明は同じ日を明細IDの降順とし、ID が取込順・時系列だと示さない", async () => {
    loadLedger.mockResolvedValue(ledger([row()]));
    const html = await render();
    expect(html).toContain("同じ日は明細IDの降順");
    expect(html).toContain("取り込んだ順ではありません");
    expect(html).not.toContain("明細IDの新しい順");
  });

  it("説明: 明細がないことは未取込の証明ではない・自動再送しない", async () => {
    loadLedger.mockResolvedValue(ledger([row()]));
    const html = await render();
    expect(html).toContain("取り込まれていない」ことの証明ではありません");
    expect(html).toContain("自動では再送しません");
  });

  it("外部由来の文字列（摘要・口座名・顧客名）は HTML としてエスケープされる", async () => {
    const evil = `<img src=x onerror=alert(1)>`;
    loadLedger.mockResolvedValue(
      ledger([row({ description: evil, wallet: { id: "w", name: `<script>alert(1)</script>` } })], { customer: { id: CID, name: evil } }),
    );
    const html = await render();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("ページ送り: 次へ・前へは page クエリだけで、1ページ目の前へと最終ページの次へは出さない", async () => {
    loadLedger.mockResolvedValue(ledger([row()], { hasNext: true }));
    let html = await render();
    expect(html).toContain(`href="/customers/${CID}/statements?page=2"`);
    expect(html).not.toContain("前のページ");
    loadLedger.mockResolvedValue(ledger([row()], { page: 2, hasPrevious: true, hasNext: true }));
    html = await render({ page: "2" });
    expect(html).toContain(`href="/customers/${CID}/statements?page=3"`);
    expect(html).toContain(`href="/customers/${CID}/statements"`);
    loadLedger.mockResolvedValue(ledger([row()], { page: 3, hasPrevious: true }));
    html = await render({ page: "3" });
    expect(html).not.toContain("次のページ");
  });

  it("表示できる最終ページでは次へを出さず、より古い明細が辿れない旨を明示する。通常ページでは出さない", async () => {
    loadLedger.mockResolvedValue(ledger([row()], { page: 10000, hasPrevious: true, olderBeyondLimit: true }));
    let html = await render({ page: "10000" });
    expect(html).not.toContain("次のページ");
    expect(html).not.toContain("page=10001");
    expect(html).toContain(`href="/customers/${CID}/statements?page=9999"`);
    expect(html).toContain("これより古い明細があります");
    loadLedger.mockResolvedValue(ledger([row()], { hasNext: true }));
    html = await render();
    expect(html).not.toContain("これより古い明細があります");
  });

  it("書込・再試行の操作を出さない（フォームは絞り込みの GET の 1 つだけ）", async () => {
    loadLedger.mockResolvedValue(ledger([row(), row({ id: "txn-2", status: "proposed" })], { hasNext: true }));
    const html = await render();
    expect(html.match(/<form\b/g)).toHaveLength(1);
    expect(html).toMatch(/<form[^>]*method="get"/i);
    expect(html).not.toMatch(/method="post"|formaction|type="hidden"|<textarea\b|type="(password|file|checkbox|radio)"/i);
    expect(html).not.toMatch(/name="page"/);
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>絞り込む<\/button>/);
    expect(html).toContain("読み取り専用");
  });
});

describe("明細一覧の絞り込み画面", () => {
  const base = `/customers/${CID}/statements`;
  /** href 内の &amp; を戻して、クエリを辞書にする */
  const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
  const query = (h: string) => Object.fromEntries(new URL(h, "http://x").searchParams);
  const flt = { status: "new" as const, walletId: W1, from: "2026-10-01", to: "2026-10-31" };
  const q = { status: "new", wallet: W1, from: "2026-10-01", to: "2026-10-31" };

  it("有効な絞り込みを解釈して読込に渡す（ページは別）。空・all は指定なし", async () => {
    loadLedger.mockResolvedValue(ledger([]));
    await render({ ...q, page: "2" });
    expect(loadLedger).toHaveBeenLastCalledWith({}, CID, 2, flt);
    await render({ status: "all", wallet: "", from: "", to: "" });
    expect(loadLedger).toHaveBeenLastCalledWith({}, CID, 1, NO_FILTERS);
  });

  it("フォーム: GET・この顧客の一覧へ・状態 8 つ+すべて・口座の選択肢・日付入力・適用/リセットが明示され、現在値が入る", async () => {
    loadLedger.mockResolvedValue(ledger([row()], { filters: flt, walletOptions: [{ id: W1, name: "普通預金" }, { id: "w-2", name: "<b>カード</b>" }] }));
    const html = await render(q);
    // 属性の順序に依存しない: 同じ <form> タグの中で GET と、この顧客の一覧への action を確かめる
    const formTags = html.match(/<form\b[^>]*>/g) ?? [];
    expect(formTags).toHaveLength(1);
    expect(formTags[0]).toMatch(/\smethod="get"/i);
    expect(formTags[0]).toContain(`action="${base}"`);
    expect(html.match(/<option value="[a-z_]+"/g)).toHaveLength(TXN_STATUSES.length + 1); // 8 状態 + all（口座の選択肢の値は UUID/ID で別）
    for (const s of TXN_STATUSES) expect(html).toContain(`value="${s}"`);
    expect(html).toMatch(/<option[^>]*value="new"[^>]*selected/);
    expect(html).toMatch(new RegExp(`<option[^>]*value="${W1}"[^>]*selected`));
    expect(html).toMatch(/<input[^>]*type="date"[^>]*name="from"[^>]*value="2026-10-01"|<input[^>]*name="from"[^>]*value="2026-10-01"/);
    expect(html).toMatch(/name="to"[^>]*value="2026-10-31"|value="2026-10-31"[^>]*name="to"/);
    expect(html).toContain("&lt;b&gt;カード&lt;/b&gt;");
    expect(html).not.toContain("<b>カード");
    expect(html).toContain("絞り込む");
    expect(hrefs(html)).toContain(base); // リセット = 絞り込みなし
    expect(html).toContain("リセット");
  });

  it("ページ送りは有効な絞り込みを全て保持し、page だけを変える。1 ページ目への前へは page なし", async () => {
    loadLedger.mockResolvedValue(ledger([row()], { filters: flt, page: 2, hasPrevious: true, hasNext: true }));
    const hs = hrefs(await render({ ...q, page: "2" }));
    expect(hs.map(query)).toContainEqual({ ...q, page: "3" });
    expect(hs.map(query)).toContainEqual(q);
    expect(hs).toContain(`${base}?status=new&wallet=${W1}&from=2026-10-01&to=2026-10-31`);
  });

  // 静的な同一性の検査: renderToStaticMarkup はブラウザの再利用（ソフトナビゲーション）を再現しないため、
  // 実際に選択が残らないことの証明にはならない。ここでは「フォームの React key が絞り込みで変わる／ページ送りで変わらない」ことだけを確かめる。
  // ブラウザでの確認（on_hold・口座を選んで適用→次へ→リセット）は Codex の実ブラウザ検証で行う。
  const formKey = async (sp: SP, l: Ledger): Promise<string | null> => {
    loadLedger.mockResolvedValue(l);
    const find = (n: unknown): string | null => {
      if (Array.isArray(n)) {
        for (const c of n) {
          const r = find(c);
          if (r !== null) return r;
        }
        return null;
      }
      if (n && typeof n === "object" && "props" in n) {
        const el = n as { key: string | null; type: unknown; props: { children?: unknown; filters?: unknown } };
        if (typeof el.type === "function" && el.type.name === "FilterForm") return el.key;
        return find(el.props.children);
      }
      return null;
    };
    return find(await StatementLedgerPage({ params: Promise.resolve({ customerId: CID }), searchParams: Promise.resolve(sp) }));
  };

  it("[静的な同一性] フォームの key は、絞り込みのリセットで変わり、同じ絞り込みのページ送りでは変わらない", async () => {
    const filtered = await formKey(q, ledger([row()], { filters: flt, hasNext: true }));
    const page2 = await formKey({ ...q, page: "2" }, ledger([row()], { filters: flt, page: 2, hasPrevious: true }));
    const reset = await formKey({}, ledger([row()]));
    expect(filtered).toBe(`${base}?status=new&wallet=${W1}&from=2026-10-01&to=2026-10-31`);
    expect(page2).toBe(filtered); // 同じ論理的な絞り込みなら、ページが変わっても作り直さない
    expect(reset).toBe(base);
    expect(reset).not.toBe(filtered); // リセットで作り直され、defaultValue が新しい値で入る
    // 別の絞り込みでも変わる
    expect(await formKey({ status: "on_hold" }, ledger([], { filters: { ...NO_FILTERS, status: "on_hold" } }))).not.toBe(filtered);
  });

  // リセットの契約: 絞り込みの有無によらず、素の <a>（Next の Link ではない）でフルナビゲーションする。
  // Link のソフトナビゲーションだと、絞り込みなしの画面で未送信の select を変えて同じ URL に戻るとき、
  // key が同じで非制御の入力が再利用され、選択が残る。モックの Link は data-next-link が付くので区別できる。
  // 実際に未送信の入力が消えることは、Codex の実ブラウザ検証で確かめる（ここでは証明しない）。
  const resetAnchors = (html: string) =>
    [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((t) => t.includes(`href="${base}"`) && !t.includes("href=\"" + base + "?"));
  it("リセットは絞り込みなし・絞り込みあり・無効入力のどれでも、Link ではない素の <a> で絞り込みなしの URL へ", async () => {
    loadLedger.mockResolvedValue(ledger([row()]));
    const none = resetAnchors(await render({}));
    expect(none).toHaveLength(1);
    expect(none[0]).not.toContain("data-next-link");

    loadLedger.mockResolvedValue(ledger([row()], { filters: flt }));
    const filtered = resetAnchors(await render(q));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).not.toContain("data-next-link");

    loadLedger.mockResolvedValue(ledger([]));
    const invalid = resetAnchors(await render({ from: "2026-13-45" }));
    expect(invalid.length).toBeGreaterThan(0);
    for (const t of invalid) expect(t).not.toContain("data-next-link");

    // ページ送りなど他のリンクは従来どおり Link
    loadLedger.mockResolvedValue(ledger([row()], { filters: flt, hasNext: true }));
    expect((await render(q)).match(/data-next-link/g)?.length ?? 0).toBeGreaterThan(0);
  });

  it("範囲外ページの『最初のページに戻る』も絞り込みを保持し、リセットは外す", async () => {
    loadLedger.mockResolvedValue(ledger([], { filters: flt, page: 9, hasPrevious: true }));
    const html = await render({ ...q, page: "9" });
    expect(html).toContain("このページに明細はありません");
    const hs = hrefs(html);
    expect(hs.map(query)).toContainEqual(q);
    expect(hs).toContain(base);
    expect(html).not.toContain("見つかりませんでした");
  });

  it("0 件の 3 種類を区別する: 絞り込みなし／絞り込みあり／範囲外。絞り込みありでも『取り込まれていない』と断定しない", async () => {
    loadLedger.mockResolvedValue(ledger([]));
    const none = await render();
    expect(none).toContain("まだ見つかりません");
    expect(none).not.toContain("条件に合う明細は");
    loadLedger.mockResolvedValue(ledger([], { filters: { ...NO_FILTERS, status: "new" } }));
    const filtered = await render({ status: "new" });
    expect(filtered).toContain("この条件に合う明細は、この画面では見つかりませんでした");
    expect(filtered).toContain("この顧客に明細がないという意味ではなく");
    expect(filtered).toContain("「取り込まれていない」とも言えません");
    expect(filtered).not.toContain("まだ見つかりません");
    expect(filtered).not.toContain("読み込めなかった");
    expect(filtered).not.toMatch(/取り込まれていません|明細はありません。/);
    expect(filtered).toContain("取り込まれていない」ことの証明ではありません"); // 共通の注意書き
  });

  it("絞り込みあり・結果ありは件数表示で条件付きと分かる。ないときは出さない", async () => {
    loadLedger.mockResolvedValue(ledger([row()], { filters: flt }));
    expect(await render(q)).toContain("条件に合う明細: 1 ページ目");
    loadLedger.mockResolvedValue(ledger([row()]));
    expect(await render()).not.toContain("条件に合う明細: ");
  });

  it("無効な入力（不正値・実在しない日・逆順・重複）は一覧を出さず、固定の案内だけ。条件を落とした結果は読まず、入力値も出さない", async () => {
    const evil = `"><script>alert(1)</script>`;
    const cases: SP[] = [{ status: "mystery" }, { wallet: evil }, { from: "2026-02-29" }, { from: "2026-10-31", to: "2026-10-01" }, { status: ["new", "approved"] }, { to: evil }];
    for (const sp of cases) {
      loadLedger.mockReset();
      loadLedger.mockResolvedValue(ledger([row()]));
      const html = await render(sp);
      expect(loadLedger).toHaveBeenLastCalledWith({}, CID, 1, null);
      expect(html).toContain("絞り込みの条件が正しくないため、明細は表示していません");
      expect(html).not.toMatch(/<section/);
      expect(html).not.toContain("まだ見つかりません");
      expect(html).not.toContain("見つかりませんでした");
      expect(html).not.toContain("<script");
      expect(html).not.toContain("mystery");
      expect(html).toContain("リセット");
    }
  });

  it("無効な項目があっても、有効な項目はフォームに残る（黙って全部消さない）", async () => {
    loadLedger.mockResolvedValue(ledger([]));
    const html = await render({ status: "new", from: "2026-02-29" });
    expect(html).toMatch(/<option[^>]*value="new"[^>]*selected/);
    expect(html).toContain("「開始日」は、実在する日付を");
    expect(html).not.toContain('value="2026-02-29"');
  });

  it("逆順は両方の日付をフォームに残して案内する", async () => {
    loadLedger.mockResolvedValue(ledger([]));
    const html = await render({ from: "2026-10-31", to: "2026-10-01" });
    expect(html).toContain("開始日」が「終了日」より後");
    expect(html).toContain('value="2026-10-31"');
    expect(html).toContain('value="2026-10-01"');
  });

  it("指定した口座が確認できないときは、明細も口座名も出さず、固定の案内を出す（0 件とも区別）", async () => {
    loadLedger.mockResolvedValue(ledger([], { filters: { ...NO_FILTERS, walletId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, walletUnavailable: true }));
    const html = await render({ wallet: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
    expect(html).toContain("この顧客の口座として確認できなかった");
    expect(html).not.toContain("見つかりませんでした");
    expect(html).not.toMatch(/<section/);
  });

  it("口座の選択肢が一部のみのときは、その旨を示す", async () => {
    loadLedger.mockResolvedValue(ledger([row()], { walletOptionsTruncated: true }));
    expect(await render()).toContain("一部の口座だけを表示");
    loadLedger.mockResolvedValue(ledger([row()]));
    expect(await render()).not.toContain("一部の口座だけを表示");
  });

  it("顧客が見えないときは、絞り込みが無効でも 404（顧客名・口座を出さない）", async () => {
    loadLedger.mockResolvedValue(null);
    await expect(render({ status: "mystery" })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("絞り込み時の読込失敗も汎用文だけで、フォーム・0 件の文を出さない", async () => {
    loadLedger.mockRejectedValue(new Error(SECRET));
    const html = await render(q);
    expect(html).toContain("明細を読み込めなかったため");
    for (const leak of ["sk-secret", "zod", "INFRA", "bank_transactions"]) expect(html).not.toContain(leak);
    expect(html).not.toContain("見つかりませんでした");
    expect(html).not.toMatch(/<section/);
  });
});
