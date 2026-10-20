import { NextResponse } from "next/server";
import { createUserClient } from "@/lib/supabase/server";

/** Google ログインの戻り先。結乃社のドメインかつ担当者として登録済みの人だけを通す */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const fail = (reason: string) => NextResponse.redirect(new URL(`/login?error=${reason}`, url.origin));
  if (!code) return fail("failed");

  const supabase = await createUserClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) return fail("failed");

  const domain = process.env.ALLOWED_LOGIN_DOMAIN;
  const email = data.user.email ?? "";
  if (!domain || !email.toLowerCase().endsWith(`@${domain.toLowerCase()}`)) {
    await supabase.auth.signOut();
    return fail("domain");
  }
  const staff = await supabase.from("staff_members").select("user_id").eq("user_id", data.user.id).maybeSingle();
  if (!staff.data) {
    await supabase.auth.signOut();
    return fail("not_staff");
  }
  return NextResponse.redirect(new URL("/", url.origin));
}
