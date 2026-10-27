import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// モジュール単位の合成テスト（ブラウザ・実 DB は通らない）
const loadPastQuality = vi.fn();
const createUserClient = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createUserClient: () => createUserClient() }));
vi.mock("@/lib/retrieval/past-quality-load", () => ({ loadPastQuality: (...a: unknown[]) => loadPastQuality(...a) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));

import { aggregatePastQuality, type PastQualityRow } from "@/lib/retrieval/past-quality";
import PastQualityPage from "@/app/customers/[customerId]/past-quality/page";

const CID = "11111111-1111-4111-8111-111111111111";
const SECRET = "sk-secret-INFRA-token zod issue at customers.id";
const render = async () => renderToStaticMarkup(await PastQualityPage({ params: Promise.resolve({ customerId: CID }) }));

const empty = (totalEntries: number) => ({
  customer: { id: CID, name: "テスト商事" },
  accounts: new Map(),
  report: {
    totalEntries,
    importedRange: null,
    keyedEntries: 0,
    groupCount: 0,
    variantGroups: [],
    stableAccountCandidates: [],
    missingKey: { count: 0, dateRange: null, entryIds: [] },
  },
});

beforeEach(() => {
  loadPastQuality.mockReset();
  createUserClient.mockReset();
  createUserClient.mockResolvedValue({});
});

describe("過去仕訳の科目の揺れ画面", () => {
  it("読込の例外の中身は表示せず、固定の失敗文だけを出す（0件とも区別する）", async () => {
    loadPastQuality.mockRejectedValue(new Error(SECRET));
    const html = await render();
    expect(html).not.toContain("sk-secret");
    expect(html).not.toContain("zod");
    expect(html).not.toContain("INFRA");
    expect(html).toContain("過去仕訳を読み込めなかったため");
    expect(html).not.toContain("まだ取り込まれていません");
  });

  it("クライアント作成の失敗も同じ固定文にする", async () => {
    createUserClient.mockRejectedValue(new Error(SECRET));
    const html = await render();
    expect(html).not.toContain("sk-secret");
    expect(html).toContain("過去仕訳を読み込めなかったため");
  });

  it("過去仕訳0件は失敗とは別の文言になる", async () => {
    loadPastQuality.mockResolvedValue(empty(0));
    const html = await render();
    expect(html).toContain("まだ取り込まれていません");
    expect(html).not.toContain("読み込めなかった");
  });

  it("顧客が見えない（null）ときは catch の外で notFound になる", async () => {
    loadPastQuality.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("グループは sticky の detail や クリック可能に見える list を使わない", async () => {
    const range = { from: "2026-01-01", to: "2026-02-01" };
    loadPastQuality.mockResolvedValue({
      ...empty(2),
      report: {
        totalEntries: 2,
        importedRange: range,
        keyedEntries: 2,
        groupCount: 1,
        variantGroups: [
          {
            direction: "expense",
            partnerKey: "ACME",
            total: 2,
            dateRange: range,
            accounts: [
              { accountItemId: 1, count: 1, dateRange: range, entryIds: ["a"] },
              { accountItemId: 2, count: 1, dateRange: range, entryIds: ["b"] },
            ],
          },
        ],
        stableAccountCandidates: [],
        missingKey: { count: 0, dateRange: null, entryIds: [] },
      },
    });
    const html = await render();
    expect(html).toContain("ACME");
    expect(html).not.toContain('class="detail"');
    expect(html).not.toContain('class="list"');
  });

  it("科目が同じ取引先を、ルール検討用の資料として根拠つきで出し、書込の操作を出さない", async () => {
    const rows: PastQualityRow[] = [
      { id: "p1", entryDate: "2026-01-05", direction: "expense", partnerKey: "ACME", accountItemId: 100 },
      { id: "p2", entryDate: "2026-02-05", direction: "expense", partnerKey: "ACME", accountItemId: 100 },
      { id: "p3", entryDate: "2026-02-06", direction: "expense", partnerKey: "SOLO", accountItemId: 200 },
      { id: "p4", entryDate: "2026-02-07", direction: "expense", partnerKey: "OLD", accountItemId: 300 },
      { id: "p5", entryDate: "2026-02-08", direction: "expense", partnerKey: "GONE", accountItemId: 999 },
      { id: "p6", entryDate: "2026-02-09", direction: "expense", partnerKey: "MIX", accountItemId: 100 },
      { id: "p7", entryDate: "2026-02-10", direction: "expense", partnerKey: "MIX", accountItemId: 200 },
    ];
    loadPastQuality.mockResolvedValue({
      customer: { id: CID, name: "テスト商事" },
      accounts: new Map([
        [100, { name: "消耗品費", available: true }],
        [200, { name: "通信費", available: true }],
        [300, { name: "旧科目", available: false }],
      ]),
      report: aggregatePastQuality(rows),
    });
    const html = await render();
    expect(html).toContain("科目が同じ取引先（ルール検討用）（4）");
    expect(html).toContain("この一覧は過去仕訳から抽出したルール検討用の資料です。");
    expect(html).toContain("この画面からルールの保存・有効化は行いません。");
    expect(html).toContain("既存ルールとの重複は確認していないため、ルール化の前に既存ルールも確認してください。");
    expect(html).toContain("過去仕訳そのものは通常の仕訳候補づくりで参照されます。");
    expect(html).not.toContain("仕訳候補の作成には使われていません");
    expect(html).toContain("税区分・補助科目");
    expect(html).toContain("金額条件");
    expect(html).toContain("取込済みの範囲");
    expect(html).toContain("消耗品費（科目ID 100）、2 件、2026-01-05 〜 2026-02-05");
    expect(html).toContain("<summary>根拠の過去仕訳ID</summary><p>p1, p2</p>");
    // 1件のみ・無効・マスタ外の警告は、該当する候補の数だけ出る（ACME の2件には出ない）
    expect(html.match(/1件のみの実績です/g)).toHaveLength(3);
    expect(html).toContain("現在のマスタでは無効です");
    expect(html).toContain("現在のマスタにありません");
    // 科目が分かれている MIX は候補ではなく揺れの側にだけ出る
    const candidates = html.slice(html.indexOf("科目が同じ取引先"), html.indexOf("取引先キーのない仕訳（"));
    expect(candidates).not.toContain("MIX");
    expect(html).toContain("MIX");
    // 書込・有効化の操作はない
    expect(html).not.toMatch(/<(button|form|input|select|textarea)\b/);
    expect(html).not.toMatch(/ルールを(作成|登録|有効化)|適用する|有効化する/);
  });

  it("候補が0件のときは、候補がないことを示し、揺れの表示は残る", async () => {
    loadPastQuality.mockResolvedValue({
      customer: { id: CID, name: "テスト商事" },
      accounts: new Map(),
      report: aggregatePastQuality([
        { id: "a", entryDate: "2026-01-01", direction: "expense", partnerKey: "MIX", accountItemId: 1 },
        { id: "b", entryDate: "2026-01-02", direction: "expense", partnerKey: "MIX", accountItemId: 2 },
      ]),
    });
    const html = await render();
    expect(html).toContain("科目が同じ取引先（ルール検討用）（0）");
    expect(html).toContain("科目が1種類だけのグループはありませんでした");
    expect(html).toContain("科目が分かれている取引先（1）");
  });
});
