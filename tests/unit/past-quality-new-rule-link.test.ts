import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadPastQuality = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createUserClient: async () => ({}) }));
vi.mock("@/lib/retrieval/past-quality-load", () => ({ loadPastQuality: (...a: unknown[]) => loadPastQuality(...a) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));

import PastQualityPage from "@/app/customers/[customerId]/past-quality/page";
import { aggregatePastQuality } from "@/lib/retrieval/past-quality";
import { parseCandidateQuery } from "@/lib/rules/candidate-schema";
import { CID } from "../fixtures/rule-editor";

const render = async () => renderToStaticMarkup(await PastQualityPage({ params: Promise.resolve({ customerId: CID }) }));

beforeEach(() => {
  loadPastQuality.mockReset();
  loadPastQuality.mockResolvedValue({
    customer: { id: CID, name: "テスト商事" },
    accounts: new Map([[100, { name: "消耗品費", available: true }]]),
    report: aggregatePastQuality([
      { id: "p1", entryDate: "2026-01-05", direction: "expense", partnerKey: "A&B=1 日本", accountItemId: 100 },
      { id: "p2", entryDate: "2026-01-06", direction: "income", partnerKey: "ZED", accountItemId: 100 },
      { id: "p3", entryDate: "2026-01-07", direction: "expense", partnerKey: "MIX", accountItemId: 1 },
      { id: "p4", entryDate: "2026-01-08", direction: "expense", partnerKey: "MIX", accountItemId: 2 },
    ]),
  });
});

const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]*rules\/new\?[^"]*)"/g)].map((m) => new URL(m[1]!.replaceAll("&amp;", "&"), "http://x"));

describe("過去仕訳の画面から新規ルール画面へのリンク", () => {
  it("科目が1種類の候補ごとに、エンコードされたリンクと依頼IDを出す（揺れのグループには出さない）", async () => {
    const links = hrefs(await render());
    expect(links).toHaveLength(2);
    const keys = links.map((u) => parseCandidateQuery(Object.fromEntries(u.searchParams))?.key).sort();
    expect(keys).toEqual(["A&B=1 日本", "ZED"]);
    for (const u of links) expect(u.pathname).toBe(`/customers/${CID}/rules/new`);
    expect(new Set(links.map((u) => u.searchParams.get("requestId"))).size).toBe(2);
  });

  it("描画のたびに新しい依頼IDを作る（動的ページ）。保存の操作自体は出さない", async () => {
    const a = hrefs(await render()).map((u) => u.searchParams.get("requestId"));
    const html = await render();
    const b = hrefs(html).map((u) => u.searchParams.get("requestId"));
    expect(a.some((id) => b.includes(id))).toBe(false);
    expect(html).not.toMatch(/<(button|form|input|select|textarea)\b/);
    expect(html).toContain("この一覧の画面自体は何も保存しません");
    expect(html).not.toContain("新しいルールを作る機能はありません");
  });
});
