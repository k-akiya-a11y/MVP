import { createBrowserClient } from "@supabase/ssr";

/** ブラウザ用（ログイン操作だけに使う）。公開してよい URL と anon キーだけを使う */
export function createBrowserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");
  return createBrowserClient(url, key);
}
