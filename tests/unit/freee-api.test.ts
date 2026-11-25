import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FreeeApiError,
  FreeeCallBudgetExceeded,
  FreeeUnauthorizedError,
  freeeReadApi,
  type CallCounter,
} from "@/lib/freee/api";
import { fakeFreee, page } from "../fixtures/fake-freee";

const TOKEN = "fake-access-token";
const counter = (limit = 100): CallCounter => ({ calls: 0, limit });

describe("freee の読み取り専用クライアント", () => {
  it("GET だけを使い、書き込む関数を持たない（freee への書込は execution 層だけ）", () => {
    const api = freeeReadApi({ counter: counter(), fetch: async () => new Response("{}") });
    expect(Object.keys(api).sort()).toEqual(["companies", "deals", "masters", "walletTxns", "walletables"]);
    const src = readFileSync("src/lib/freee/api.ts", "utf8");
    expect(src).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
  });

  it("アクセストークンを Authorization に付けて GET する", async () => {
    const f = fakeFreee({ "/api/1/companies": () => ({ body: { companies: [{ id: 900001, display_name: "架空の事業所" }] } }) });
    const companies = await freeeReadApi({ fetch: f.fetch, counter: counter() }).companies(TOKEN);
    expect(companies).toEqual([{ id: 900001, display_name: "架空の事業所" }]);
    expect(f.calls[0]!.method).toBe("GET");
    expect(f.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("取引先は offset/limit で最後のページまで読む", async () => {
    const partners = Array.from({ length: 3001 }, (_, i) => ({ id: i + 1, name: `取引先${i + 1}` }));
    const f = fakeFreee({
      "/api/1/account_items": () => ({ body: { account_items: [] } }),
      "/api/1/partners": (url) => ({ body: { partners: page(url, partners) } }),
      "/api/1/items": () => ({ body: { items: [] } }),
      "/api/1/sections": () => ({ body: { sections: [] } }),
      "/api/1/tags": () => ({ body: { tags: [] } }),
      "/api/1/taxes/companies/900001": () => ({ body: { taxes: [] } }),
    });
    const m = await freeeReadApi({ fetch: f.fetch, counter: counter() }).masters(TOKEN, 900001);
    expect(m.partners).toHaveLength(3001);
    expect(f.calls.filter((c) => c.url.pathname === "/api/1/partners")).toHaveLength(2);
  });

  it("401 は FreeeUnauthorizedError、それ以外のエラーは本文を載せない FreeeApiError", async () => {
    const f = fakeFreee({
      "/api/1/companies": () => ({ status: 401, body: { message: "expired" } }),
      "/api/1/walletables": () => ({ status: 500, body: { message: "秘密の会社データ" } }),
    });
    const api = freeeReadApi({ fetch: f.fetch, counter: counter() });
    await expect(api.companies(TOKEN)).rejects.toBeInstanceOf(FreeeUnauthorizedError);
    const err = await api.walletables(TOKEN, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreeeApiError);
    expect(String((err as Error).message)).not.toContain("秘密の会社データ");
  });

  it("応答の形が違えば例外にする（金額が小数・ID が文字列など）", async () => {
    const f = fakeFreee({
      "/api/1/deals": () => ({
        body: { deals: [{ id: "1", issue_date: "2026-10-01", type: "expense", amount: 1.5, details: [] }], meta: { total_count: 1 } },
      }),
    });
    await expect(freeeReadApi({ fetch: f.fetch, counter: counter() }).deals(TOKEN, 1, "2026-10-01", "2026-10-31")).rejects.toThrow();
  });

  it("呼出しの予算を使い切ったら、freee を呼ばずに止める", async () => {
    const f = fakeFreee({ "/api/1/companies": () => ({ body: { companies: [] } }) });
    const c = counter(1);
    const api = freeeReadApi({ fetch: f.fetch, counter: c });
    await api.companies(TOKEN);
    await expect(api.companies(TOKEN)).rejects.toBeInstanceOf(FreeeCallBudgetExceeded);
    expect(f.calls).toHaveLength(1);
  });
});
