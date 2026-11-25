import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FetchLike } from "./api";

/**
 * freee の OAuth 2.0（認可コード）。設計書3章: 結乃社の担当者アカウント（顧客の事業所にメンバー参加済み）で認可し、
 * 事業所 ID（company_id）で顧客を切り替える。
 *
 * - トークンの取得・更新だけを行い、保存はしない（保存は Vault。tokens.ts と token-store.ts）
 * - クライアントシークレットはサーバー側の環境変数だけで扱い、画面やログに出さない
 * - freee の応答本文はエラーにも載せない（トークンが入りうるため）。状態コードと、freee が返したエラーの種類だけを残す
 */

export const FREEE_AUTHORIZE_URL = "https://accounts.secure.freee.co.jp/public_api/authorize";
export const FREEE_TOKEN_URL = "https://accounts.secure.freee.co.jp/public_api/token";
/**
 * トークンの発行・更新を待つ上限。トークン更新のロック（REFRESH_LOCK_SECONDS = 60 秒）より十分短くし、
 * ロックの期限内に「保存」か「失敗の記録」まで終える（期限が切れたロックは、DB が結果不明として再認可待ちにする）
 */
export const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

export type FreeeOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string };

export function freeeOAuthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FreeeOAuthConfig {
  const clientId = env.FREEE_CLIENT_ID ?? "";
  const clientSecret = env.FREEE_CLIENT_SECRET ?? "";
  const redirectUri = env.FREEE_REDIRECT_URI ?? "";
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("FREEE_CLIENT_ID・FREEE_CLIENT_SECRET・FREEE_REDIRECT_URI が設定されていません");
  }
  return { clientId, clientSecret, redirectUri };
}

/** 認可画面の URL。prompt=select_company で、認可する事業所を選ばせる */
export function buildAuthorizeUrl(config: Pick<FreeeOAuthConfig, "clientId" | "redirectUri">, state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
    prompt: "select_company",
  });
  return `${FREEE_AUTHORIZE_URL}?${q.toString()}`;
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
  company_id: z.number().int().positive().safe().nullable().optional(),
});

export type FreeeTokens = { accessToken: string; refreshToken: string; expiresAt: Date; companyId: number | null };

/** freee がトークンの発行・更新を断った。invalidGrant はリフレッシュトークン（または認可コード）が無効で、再認可が必要 */
export class FreeeTokenError extends Error {
  constructor(
    readonly status: number,
    readonly invalidGrant: boolean,
  ) {
    super(`freee がトークンの発行を断りました（HTTP ${status}${invalidGrant ? "、invalid_grant" : ""}）`);
  }
}

async function requestToken(
  params: Record<string, string>,
  config: FreeeOAuthConfig,
  deps: { fetch?: FetchLike; now?: () => number },
): Promise<FreeeTokens> {
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const res = await doFetch(FREEE_TOKEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...params, client_id: config.clientId, client_secret: config.clientSecret }).toString(),
  });
  if (!res.ok) {
    let invalidGrant = false;
    try {
      const body = (await res.json()) as { error?: unknown };
      invalidGrant = body.error === "invalid_grant";
    } catch {
      // 本文が JSON でなければ、種類は分からないものとする
    }
    throw new FreeeTokenError(res.status, invalidGrant);
  }
  const t = tokenSchema.parse(await res.json());
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: new Date(now() + t.expires_in * 1000),
    companyId: t.company_id ?? null,
  };
}

export function exchangeAuthorizationCode(code: string, config: FreeeOAuthConfig, deps: { fetch?: FetchLike; now?: () => number } = {}) {
  return requestToken({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri }, config, deps);
}

export function refreshAccessToken(refreshToken: string, config: FreeeOAuthConfig, deps: { fetch?: FetchLike; now?: () => number } = {}) {
  return requestToken({ grant_type: "refresh_token", refresh_token: refreshToken }, config, deps);
}

/**
 * CSRF 対策の state。乱数を freee に渡し、同じ乱数と顧客 ID を、署名つきの cookie（httpOnly）に入れておく。
 * 戻ってきたときに、state と cookie の乱数・署名・期限が合うときだけ受け付ける。顧客 ID は cookie から取る（URL の値は信用しない）
 */
export const OAUTH_STATE_COOKIE = "freee_oauth_state";
export const OAUTH_STATE_TTL_SECONDS = 600;

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createOAuthState(customerId: string, secret: string, now = Date.now()): { state: string; cookie: string } {
  const state = randomBytes(32).toString("base64url");
  const payload = `${state}.${customerId}.${now + OAUTH_STATE_TTL_SECONDS * 1000}`;
  return { state, cookie: `${payload}.${sign(payload, secret)}` };
}

/** 合えば顧客 ID を返す。合わなければ null */
export function verifyOAuthState(state: string | null, cookie: string | undefined, secret: string, now = Date.now()): string | null {
  if (!state || !cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 4) return null;
  const [cookieState, customerId, expires, signature] = parts as [string, string, string, string];
  const expected = sign(`${cookieState}.${customerId}.${expires}`, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const s1 = Buffer.from(state);
  const s2 = Buffer.from(cookieState);
  if (s1.length !== s2.length || !timingSafeEqual(s1, s2)) return null;
  if (!/^\d+$/.test(expires) || Number(expires) < now) return null;
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) return null;
  return customerId;
}
