import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { FreeeTokenStoreError, saveFreeeConnection, supabaseFreeeTokenStore } from "@/lib/freee/token-store";

// トークンを扱う境界（Vault の関数の呼出し）の失敗は、固定の文言だけの例外にする。DB のエラー文や応答の値は載せない
const SECRET = "SECRET-fake-token-0123456789";
const C = "10000000-0000-4000-8000-000000000001";

function service(reply: { data?: unknown; error?: { message: string; code?: string } | null }): SupabaseClient {
  return { rpc: async () => ({ data: reply.data ?? null, error: reply.error ?? null }) } as unknown as SupabaseClient;
}

describe("トークンの保存先の失敗は固定の文言にする", () => {
  it("DB のエラー文に秘密の値が入っていても、例外には出さない（SQLSTATE だけ残す）", async () => {
    const store = supabaseFreeeTokenStore(service({ error: { message: `boom ${SECRET}`, code: "P0001" } }));
    const calls = [
      () => store.get(C),
      () => store.beginRefresh(C, "o", 60),
      () => store.completeRefresh(C, "o", { accessToken: SECRET, refreshToken: SECRET, expiresAt: new Date(), companyId: null }),
      () => store.failRefresh(C, "o", true),
    ];
    for (const call of calls) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FreeeTokenStoreError);
      expect(String((err as Error).message)).not.toContain(SECRET);
      expect(String((err as Error).message)).toContain("P0001");
    }
    const err = await saveFreeeConnection(service({ error: { message: SECRET } }), {
      customerId: C,
      companyId: 1,
      tokens: { accessToken: SECRET, refreshToken: SECRET, expiresAt: new Date(), companyId: 1 },
      connectedBy: "a",
    }).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain(SECRET);
  });

  it("応答の形が違っても、検証のエラーに値を載せない", async () => {
    const store = supabaseFreeeTokenStore(
      service({ data: [{ freee_company_id: "x", status: "active", access_token: SECRET, access_token_expires_at: "x" }] }),
    );
    const err = await store.get(C).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreeeTokenStoreError);
    expect(String((err as Error).message)).not.toContain(SECRET);
  });
});
