import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { FREEE_TOKEN_URL } from "@/lib/freee/oauth";
import { runFreeeSync, type FreeeSyncRunLog } from "@/lib/freee/run";
import type { FreeeSyncStore } from "@/lib/freee/sync";
import type { FreeeTokenStore } from "@/lib/freee/tokens";
import { fakeFreee } from "../fixtures/fake-freee";

const C = "10000000-0000-4000-8000-000000000001";
const oauth = { clientId: "fake", clientSecret: "fake-secret", redirectUri: "http://localhost:3000/api/auth/freee/callback" };
const service = {} as SupabaseClient; // 使わない（保存先はすべて差し替える）

function deps(routes: Parameters<typeof fakeFreee>[0], over: { tokenExpiresAt?: number } = {}) {
  const f = fakeFreee({
    [new URL(FREEE_TOKEN_URL).pathname]: () => ({ body: { access_token: "a2", refresh_token: "r2", expires_in: 21600 } }),
    ...routes,
  });
  const runs: { kind: string; result?: unknown }[] = [];
  const runLog: FreeeSyncRunLog = {
    start: async (_c, kind) => {
      runs.push({ kind });
      return String(runs.length - 1);
    },
    finish: async (id, result) => {
      runs[Number(id)]!.result = result;
    },
  };
  let access = "a1";
  const tokenStore: FreeeTokenStore = {
    get: async () => ({ companyId: 900001, status: "active", accessToken: access, expiresAt: new Date(over.tokenExpiresAt ?? Date.now() + 3600_000) }),
    beginRefresh: async () => "r1",
    completeRefresh: async (_c, _o, t) => {
      access = t.accessToken;
    },
    failRefresh: async () => undefined,
  };
  const syncStore: FreeeSyncStore = {
    syncMasters: vi.fn(async () => ({ upserted: 1, madeUnavailable: 0 })),
    loadPastEntryState: async () => ({ from: "2026-10-01", until: "2026-10-01", nextMonth: "2026-10-01", completed: false, mastersSyncedAt: "x" }),
    loadPartnerNames: async () => new Map(),
    applyPastEntries: vi.fn(async (_c, rows) => rows.length),
  };
  return { f, runs, d: { service, oauth, fetch: f.fetch, tokenStore, syncStore, runLog, today: "2026-10-20" } };
}

const mastersRoutes = {
  "/api/1/account_items": () => ({ body: { account_items: [{ id: 105, name: "地代家賃" }] } }),
  "/api/1/partners": () => ({ body: { partners: [] } }),
  "/api/1/items": () => ({ body: { items: [] } }),
  "/api/1/sections": () => ({ body: { sections: [] } }),
  "/api/1/tags": () => ({ body: { tags: [] } }),
  "/api/1/taxes/companies/900001": () => ({ body: { taxes: [] } }),
  "/api/1/deals": () => ({ body: { deals: [], meta: { total_count: 0 } } }),
};

describe("freee の同期の実行（1顧客）", () => {
  it("マスタ → 過去仕訳の順に読み、それぞれ実行記録を残す。freee には GET とトークンの POST だけ", async () => {
    const { f, runs, d } = deps(mastersRoutes);
    const r = await runFreeeSync(C, d, "admin");
    expect(r.results.masters.status).toBe("completed");
    expect(r.results.past_entries.status).toBe("completed");
    expect(runs.map((x) => x.kind)).toEqual(["masters", "past_entries"]);
    expect(f.calls.every((c) => c.method === "GET" || c.url.toString() === FREEE_TOKEN_URL)).toBe(true);
  });

  it("マスタが失敗したら、過去仕訳は取り込まず、その理由を記録する", async () => {
    const { runs, d } = deps({ ...mastersRoutes, "/api/1/account_items": () => ({ status: 500, body: {} }) });
    const r = await runFreeeSync(C, d);
    expect(r.results.masters).toMatchObject({ status: "failed", error: expect.stringContaining("HTTP 500") });
    expect(r.results.past_entries).toMatchObject({ status: "failed", error: expect.stringContaining("マスタの同期が終わらなかった") });
    expect(runs).toHaveLength(2);
  });

  it("freee が 401 を返したら、1回だけトークンを更新してやり直す", async () => {
    let first = true;
    const { f, d } = deps({
      ...mastersRoutes,
      "/api/1/account_items": () => {
        if (first) {
          first = false;
          return { status: 401, body: {} };
        }
        return { body: { account_items: [] } };
      },
    });
    const r = await runFreeeSync(C, d);
    expect(r.results.masters.status).toBe("completed");
    expect(f.calls.filter((c) => c.url.toString() === FREEE_TOKEN_URL)).toHaveLength(1);
    expect(f.calls.filter((c) => c.url.pathname === "/api/1/account_items").map((c) => c.headers.Authorization)).toEqual([
      "Bearer a1",
      "Bearer a2",
    ]);
  });

  it("1か月以上進んでから呼出しの上限に達したら、過去仕訳は失敗にせず、続きを次回に回す", async () => {
    const { d } = deps(mastersRoutes);
    d.syncStore.loadPastEntryState = async () => ({
      from: "2026-09-01",
      until: "2026-10-01",
      nextMonth: "2026-09-01",
      completed: false,
      mastersSyncedAt: "x",
    });
    // マスタ 6 回 + 9月の取引 1 回。10月の取引で上限
    const r = await runFreeeSync(C, { ...d, callLimit: 7 });
    expect(r.results.past_entries).toMatchObject({
      status: "completed",
      counts: { months: 1, stoppedByCallLimit: true, nextMonth: "2026-10-01" },
    });
  });

  it("上限のせいで1か月も進めなければ、過去仕訳は失敗として記録する（前進しないまま完了にしない）", async () => {
    const { runs, d } = deps(mastersRoutes);
    const r = await runFreeeSync(C, { ...d, callLimit: 6 });
    expect(r.results.masters.status).toBe("completed");
    expect(r.results.past_entries).toMatchObject({ status: "failed", error: expect.stringContaining("1か月も進めていません") });
    expect(runs[1]!.result).toMatchObject({ status: "failed" });
  });

  it("外部や DB のエラー文に秘密の値が入っていても、同期の結果と記録には固定の文言しか残さない", async () => {
    const SECRET = "SECRET-token-0123456789";
    const { runs, d } = deps(mastersRoutes);
    d.syncStore.syncMasters = async () => {
      throw new Error("db said " + SECRET);
    };
    const r1 = await runFreeeSync(C, d);
    expect(JSON.stringify([r1, runs])).not.toContain(SECRET);
    expect(r1.results.masters.error).toBe("同期中に想定外のエラーが起きました");

    const { runs: runs2, d: d2 } = deps(mastersRoutes);
    const base = d2.fetch;
    const failingFetch = async (input: string, init?: RequestInit) => {
      if (input.includes("/api/1/deals")) throw new TypeError("fetch failed " + SECRET);
      return base(input, init);
    };
    const r2 = await runFreeeSync(C, { ...d2, fetch: failingFetch });
    expect(r2.results.past_entries).toMatchObject({ status: "failed", error: "同期中に想定外のエラーが起きました" });
    expect(JSON.stringify([r2, runs2])).not.toContain(SECRET);
  });
});
