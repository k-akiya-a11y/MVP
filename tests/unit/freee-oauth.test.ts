import { describe, expect, it } from "vitest";
import {
  FREEE_TOKEN_URL,
  FreeeTokenError,
  buildAuthorizeUrl,
  createOAuthState,
  exchangeAuthorizationCode,
  refreshAccessToken,
  verifyOAuthState,
} from "@/lib/freee/oauth";
import { fakeFreee } from "../fixtures/fake-freee";

const config = { clientId: "fake-client", clientSecret: "fake-secret", redirectUri: "http://localhost:3000/api/auth/freee/callback" };
const CUSTOMER = "10000000-0000-4000-8000-000000000001";
const tokenPath = new URL(FREEE_TOKEN_URL).pathname;

describe("freee の OAuth", () => {
  it("認可画面の URL に client_id・redirect_uri・state・事業所の選択を付ける（シークレットは付けない）", () => {
    const u = new URL(buildAuthorizeUrl(config, "st"));
    expect(u.searchParams.get("client_id")).toBe("fake-client");
    expect(u.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("prompt")).toBe("select_company");
    expect(u.toString()).not.toContain("fake-secret");
  });

  it("認可コードをトークンに替え、期限を計算する", async () => {
    const f = fakeFreee({
      [tokenPath]: () => ({ body: { access_token: "a1", refresh_token: "r1", expires_in: 21600, company_id: 900001 } }),
    });
    const t = await exchangeAuthorizationCode("code1", config, { fetch: f.fetch, now: () => 1_000 });
    expect(t).toEqual({ accessToken: "a1", refreshToken: "r1", expiresAt: new Date(1_000 + 21600 * 1000), companyId: 900001 });
    const body = new URLSearchParams(f.calls[0]!.body ?? "");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code1");
  });

  it("更新を断られたら invalid_grant かどうかを伝える（本文は載せない）", async () => {
    const f = fakeFreee({ [tokenPath]: () => ({ status: 400, body: { error: "invalid_grant", error_description: "r1 は使用済み" } }) });
    const err = await refreshAccessToken("r1", config, { fetch: f.fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreeeTokenError);
    expect((err as FreeeTokenError).invalidGrant).toBe(true);
    expect((err as Error).message).not.toContain("使用済み");
  });

  describe("state（CSRF 対策）", () => {
    it("同じ state と署名つき cookie なら、cookie の顧客 ID を返す", () => {
      const { state, cookie } = createOAuthState(CUSTOMER, "k", 0);
      expect(verifyOAuthState(state, cookie, "k", 1)).toBe(CUSTOMER);
    });

    it("state が違う・署名が違う・期限切れ・cookie がないときは null", () => {
      const { state, cookie } = createOAuthState(CUSTOMER, "k", 0);
      expect(verifyOAuthState(`${state}x`, cookie, "k", 1)).toBeNull();
      expect(verifyOAuthState(state, cookie, "other-key", 1)).toBeNull();
      expect(verifyOAuthState(state, cookie, "k", 11 * 60 * 1000)).toBeNull();
      expect(verifyOAuthState(state, undefined, "k", 1)).toBeNull();
    });

    it("cookie の顧客 ID を書き換えると署名が合わず null", () => {
      const { state, cookie } = createOAuthState(CUSTOMER, "k", 0);
      const tampered = cookie.replace(CUSTOMER, "10000000-0000-4000-8000-000000000002");
      expect(verifyOAuthState(state, tampered, "k", 1)).toBeNull();
    });
  });
});
