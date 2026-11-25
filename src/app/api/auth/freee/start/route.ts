import { NextResponse } from "next/server";
import { currentAdminId } from "@/lib/freee/admin";
import { OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_SECONDS, buildAuthorizeUrl, createOAuthState, freeeOAuthConfigFromEnv } from "@/lib/freee/oauth";
import { createUserClient } from "@/lib/supabase/server";

/**
 * freee との接続を始める（管理者だけ）。認可画面へ送り、CSRF 対策の state を署名つきの cookie に入れる。
 * 顧客が見えない・freee の事業所 ID が未設定・設定が足りないときは、理由を固定の文言で返す（詳細は出さない）
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId") ?? "";
  const back = (result: string) =>
    NextResponse.redirect(new URL(`/customers/${encodeURIComponent(customerId)}/freee?result=${result}`, url.origin));
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) return NextResponse.json({ error: "顧客の指定が正しくありません" }, { status: 400 });

  const client = await createUserClient();
  if (!(await currentAdminId(client))) return back("not_admin");
  const { data: customer, error } = await client.from("customers").select("id, freee_company_id").eq("id", customerId).maybeSingle();
  if (error || !customer) return back("not_found");
  if (customer.freee_company_id === null) return back("no_company_id");

  let config;
  try {
    config = freeeOAuthConfigFromEnv();
  } catch {
    return back("not_configured");
  }
  const { state, cookie } = createOAuthState(customerId, config.clientSecret);
  const res = NextResponse.redirect(buildAuthorizeUrl(config, state));
  res.cookies.set(OAUTH_STATE_COOKIE, cookie, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/auth/freee",
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });
  return res;
}
