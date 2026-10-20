"use client";

import { createBrowserSupabase } from "@/lib/supabase/browser";

export function LoginButton({ hostedDomain }: { hostedDomain: string }) {
  async function signIn() {
    await createBrowserSupabase().auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        // Google の画面で結乃社のドメインのアカウントだけを出す（確認はサーバー側でも行う）
        queryParams: hostedDomain ? { hd: hostedDomain } : undefined,
      },
    });
  }
  return (
    <button type="button" onClick={signIn}>
      Google でログイン
    </button>
  );
}
