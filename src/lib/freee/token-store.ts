import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { FreeeTokens } from "./oauth";
import type { FreeeTokenStore, StoredAccessToken } from "./tokens";

/**
 * トークンの保存先（Supabase Vault）。service_role のクライアントだけで使う（関数は service_role だけが実行できる。
 * supabase/migrations/20261125000100_freee_connections.sql）。トークンの値はログにも例外にも出さない
 */

const rowSchema = z.object({
  freee_company_id: z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number).pipe(z.number().int().positive().safe()),
  status: z.enum(["active", "needs_reauth"]),
  access_token: z.string().min(1),
  access_token_expires_at: z.string().transform((s) => new Date(s)).pipe(z.date()),
});

function fail(what: string, error: { message?: string } | null): never {
  // DB のエラー文にはトークンは入らない（引数は載らない）が、念のため固定の説明を前に置く
  throw new Error(`${what}に失敗しました（${error?.message ?? "不明なエラー"}）`);
}

export function supabaseFreeeTokenStore(service: SupabaseClient): FreeeTokenStore {
  return {
    async get(customerId): Promise<StoredAccessToken | null> {
      const { data, error } = await service.rpc("get_freee_access_token", { p_customer_id: customerId });
      if (error) fail("freee のトークンの読込", error);
      const rows = z.array(z.unknown()).parse(data ?? []);
      if (rows.length === 0) return null;
      const r = rowSchema.parse(rows[0]);
      return { companyId: r.freee_company_id, status: r.status, accessToken: r.access_token, expiresAt: r.access_token_expires_at };
    },
    async beginRefresh(customerId, owner, lockSeconds) {
      const { data, error } = await service.rpc("begin_freee_token_refresh", {
        p_customer_id: customerId,
        p_owner: owner,
        p_lock_seconds: lockSeconds,
      });
      if (error) fail("freee のトークン更新のロック", error);
      const rows = z.array(z.object({ refresh_token: z.string().min(1) })).parse(data ?? []);
      return rows[0]?.refresh_token ?? null;
    },
    async completeRefresh(customerId, owner, tokens: FreeeTokens) {
      const { error } = await service.rpc("complete_freee_token_refresh", {
        p_customer_id: customerId,
        p_owner: owner,
        p_access_token: tokens.accessToken,
        p_refresh_token: tokens.refreshToken,
        p_expires_at: tokens.expiresAt.toISOString(),
      });
      if (error) fail("freee の新しいトークンの保存", error);
    },
    async failRefresh(customerId, owner, needsReauth) {
      const { error } = await service.rpc("fail_freee_token_refresh", {
        p_customer_id: customerId,
        p_owner: owner,
        p_needs_reauth: needsReauth,
      });
      if (error) fail("freee のトークン更新のロックの解除", error);
    },
  };
}

/** OAuth の認可が終わったときに接続を保存する（管理者・事業所の一致は DB の関数でも確かめる） */
export async function saveFreeeConnection(
  service: SupabaseClient,
  args: { customerId: string; companyId: number; tokens: FreeeTokens; connectedBy: string },
) {
  const { error } = await service.rpc("save_freee_connection", {
    p_customer_id: args.customerId,
    p_company_id: args.companyId,
    p_access_token: args.tokens.accessToken,
    p_refresh_token: args.tokens.refreshToken,
    p_expires_at: args.tokens.expiresAt.toISOString(),
    p_connected_by: args.connectedBy,
  });
  if (error) fail("freee との接続の保存", error);
}
