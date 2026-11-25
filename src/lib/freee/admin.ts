import type { SupabaseClient } from "@supabase/supabase-js";

/** ログイン中の人が管理者なら、その ID を返す。管理者でなければ null（freee との接続・同期は管理者だけが行う） */
export async function currentAdminId(client: SupabaseClient): Promise<string | null> {
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) return null;
  const { data, error } = await client.rpc("is_admin");
  if (error || data !== true) return null;
  return userData.user.id;
}

/** 今日の日付（日本時間、YYYY-MM-DD） */
export function todayJst(now = new Date()): string {
  return now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}
