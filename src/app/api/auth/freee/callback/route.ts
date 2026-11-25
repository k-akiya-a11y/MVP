import { NextResponse, type NextRequest } from "next/server";
import { freeeReadApi } from "@/lib/freee/api";
import { currentAdminId } from "@/lib/freee/admin";
import { OAUTH_STATE_COOKIE, exchangeAuthorizationCode, freeeOAuthConfigFromEnv, verifyOAuthState } from "@/lib/freee/oauth";
import { saveFreeeConnection } from "@/lib/freee/token-store";
import { createServiceClient, createUserClient } from "@/lib/supabase/server";

/**
 * freee の認可の戻り先。次をすべて満たすときだけ接続を保存する（どれか1つでも外れたら保存しない）:
 * 1. state が署名つき cookie と一致し、期限内（顧客 ID は cookie から取り、URL の値は使わない）
 * 2. ログイン中の人が管理者で、その顧客が見える
 * 3. 認可した事業所が、顧客に登録された freee の事業所 ID と一致し、認可したユーザーがその事業所に参加している
 * 結果は固定の文言のコードだけを画面に返す（トークンや freee の応答は出さない）。DB の関数も事業所と管理者を確かめ直す
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  let config;
  try {
    config = freeeOAuthConfigFromEnv();
  } catch {
    return NextResponse.json({ error: "freee の設定がありません" }, { status: 500 });
  }
  const customerId = verifyOAuthState(url.searchParams.get("state"), request.cookies.get(OAUTH_STATE_COOKIE)?.value, config.clientSecret);
  if (!customerId) return NextResponse.json({ error: "接続の確認に失敗しました。最初からやり直してください" }, { status: 400 });

  const back = (result: string) => {
    const res = NextResponse.redirect(new URL(`/customers/${customerId}/freee?result=${result}`, url.origin));
    res.cookies.set(OAUTH_STATE_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/api/auth/freee", maxAge: 0 });
    return res;
  };
  const code = url.searchParams.get("code");
  if (!code) return back("denied");

  const client = await createUserClient();
  const adminId = await currentAdminId(client);
  if (!adminId) return back("not_admin");
  const { data: customer, error } = await client.from("customers").select("id, freee_company_id").eq("id", customerId).maybeSingle();
  if (error || !customer || customer.freee_company_id === null) return back("not_found");
  const expected = Number(customer.freee_company_id);

  try {
    const tokens = await exchangeAuthorizationCode(code, config);
    if (tokens.companyId !== null && tokens.companyId !== expected) return back("company_mismatch");
    const companies = await freeeReadApi({ counter: { calls: 0, limit: 1 } }).companies(tokens.accessToken);
    if (!companies.some((c) => c.id === expected)) return back("company_mismatch");
    await saveFreeeConnection(createServiceClient(), { customerId, companyId: expected, tokens, connectedBy: adminId });
  } catch {
    return back("failed");
  }
  return back("connected");
}
