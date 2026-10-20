import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * ログイン中の担当者として DB に接続する（RLS が効く）。
 * 画面・API ルートからの読取と、担当者の名前で記録する操作（明細取込・人の確認）はこれを使う。
 */
export async function createUserClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  return createServerClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) cookieStore.set(name, value, options);
        } catch {
          // Server Component からは cookie を書けない。セッション更新は middleware で行う
        }
      },
    },
  });
}

/**
 * サーバー側の処理（AI判断の記録、マスタ同期、実行ログ）用。RLS を通らないので、
 * 呼び出す側で対象の顧客を必ず確認する。クライアントには絶対に渡さない。
 */
export function createServiceClient(): SupabaseClient {
  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
