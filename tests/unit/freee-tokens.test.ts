import { describe, expect, it, vi } from "vitest";
import { FreeeTokenError, type FreeeTokens } from "@/lib/freee/oauth";
import {
  FreeeNeedsReauthError,
  FreeeNotConnectedError,
  FreeeRefreshNotSavedError,
  REFRESH_MARGIN_MS,
  getFreeeAccessToken,
  type FreeeTokenStore,
} from "@/lib/freee/tokens";

const C = "10000000-0000-4000-8000-000000000001";
const NOW = 1_000_000_000;

/** DB の関数（begin/complete/fail_freee_token_refresh）の手順を写した偽の保存先。ロックは所有者つきで1つだけ */
function fakeStore(init: { accessToken: string; refreshToken: string; expiresAt: number; status?: "active" | "needs_reauth" }) {
  const s = { ...init, status: init.status ?? "active", lockOwner: null as string | null, refreshTokensUsed: [] as string[] };
  const store: FreeeTokenStore = {
    get: async () => ({ companyId: 900001, status: s.status, accessToken: s.accessToken, expiresAt: new Date(s.expiresAt) }),
    beginRefresh: async (_c, owner) => {
      await Promise.resolve();
      if (s.lockOwner && s.lockOwner !== owner) return null;
      s.lockOwner = owner;
      return s.refreshToken;
    },
    completeRefresh: async (_c, owner, t: FreeeTokens) => {
      if (s.lockOwner !== owner) throw new Error("トークン更新のロックを持っていません");
      s.accessToken = t.accessToken;
      s.refreshToken = t.refreshToken;
      s.expiresAt = t.expiresAt.getTime();
      s.lockOwner = null;
    },
    failRefresh: async (_c, owner, needsReauth) => {
      if (s.lockOwner !== owner) return;
      s.lockOwner = null;
      if (needsReauth) s.status = "needs_reauth";
    },
  };
  return { s, store };
}

/** 使い捨てのリフレッシュトークン（同じものを2回使うと invalid_grant）を写した偽の freee */
function fakeRefresh(s: { refreshTokensUsed: string[] }) {
  let n = 0;
  return vi.fn(async (rt: string): Promise<FreeeTokens> => {
    await new Promise((r) => setTimeout(r, 5));
    if (s.refreshTokensUsed.includes(rt)) throw new FreeeTokenError(400, true);
    s.refreshTokensUsed.push(rt);
    n++;
    return { accessToken: `a${n + 1}`, refreshToken: `r${n + 1}`, expiresAt: new Date(NOW + 6 * 3600 * 1000), companyId: 900001 };
  });
}

const noSleep = async () => {
  await new Promise((r) => setTimeout(r, 1));
};

describe("freee のアクセストークン（更新は一か所・ロックつき）", () => {
  it("期限まで余裕があれば更新しない", async () => {
    const { s, store } = fakeStore({ accessToken: "a1", refreshToken: "r1", expiresAt: NOW + REFRESH_MARGIN_MS + 1 });
    const refresh = fakeRefresh(s);
    await expect(getFreeeAccessToken(C, { store, refresh, now: () => NOW })).resolves.toEqual({ accessToken: "a1", companyId: 900001 });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("期限が近ければ更新し、新しいトークンを保存する", async () => {
    const { s, store } = fakeStore({ accessToken: "a1", refreshToken: "r1", expiresAt: NOW + 1000 });
    const refresh = fakeRefresh(s);
    const t = await getFreeeAccessToken(C, { store, refresh, now: () => NOW });
    expect(t.accessToken).toBe("a2");
    expect(s).toMatchObject({ accessToken: "a2", refreshToken: "r2", lockOwner: null });
  });

  it("同時に2つの処理が期限切れに気づいても、freee への更新は1回だけ（使い捨てのトークンを二重に使わない）", async () => {
    const { s, store } = fakeStore({ accessToken: "a1", refreshToken: "r1", expiresAt: NOW - 1 });
    const refresh = fakeRefresh(s);
    const deps = { store, refresh, now: () => NOW, sleep: noSleep };
    const [x, y] = await Promise.all([getFreeeAccessToken(C, deps), getFreeeAccessToken(C, deps)]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(x.accessToken).toBe("a2");
    expect(y.accessToken).toBe("a2");
    expect(s.status).toBe("active");
  });

  it("freee が更新を断った（invalid_grant）ら、再認可が必要にしてロックを外す", async () => {
    const { s, store } = fakeStore({ accessToken: "a1", refreshToken: "r1", expiresAt: NOW - 1 });
    s.refreshTokensUsed.push("r1");
    await expect(getFreeeAccessToken(C, { store, refresh: fakeRefresh(s), now: () => NOW })).rejects.toBeInstanceOf(FreeeNeedsReauthError);
    expect(s).toMatchObject({ status: "needs_reauth", lockOwner: null });
  });

  it("通信の失敗・期限切れ（結果が分からない）でも、同じトークンを再送しないよう再認可待ちにする。外部のエラー文は出さない", async () => {
    const { s, store } = fakeStore({ accessToken: "a1", refreshToken: "r1", expiresAt: NOW - 1 });
    const refresh = vi.fn(async () => {
      throw new Error("timeout SECRET-refresh-r1");
    });
    const err = await getFreeeAccessToken(C, { store, refresh, now: () => NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreeeNeedsReauthError);
    expect(String((err as Error).message)).not.toContain("SECRET");
    expect(s).toMatchObject({ status: "needs_reauth", lockOwner: null });
    // 2回目は freee を呼ばない
    await expect(getFreeeAccessToken(C, { store, refresh, now: () => NOW })).rejects.toBeInstanceOf(FreeeNeedsReauthError);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("更新できたのに保存できなければ、そのことを例外で伝える（黙って続けない）", async () => {
    const { s, store } = fakeStore({ accessToken: "a1", refreshToken: "r1", expiresAt: NOW - 1 });
    store.completeRefresh = async () => {
      throw new Error("db down SECRET-access-a2");
    };
    const err = await getFreeeAccessToken(C, { store, refresh: fakeRefresh(s), now: () => NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreeeRefreshNotSavedError);
    expect(String((err as Error).message)).not.toContain("SECRET");
    expect(s.status).toBe("needs_reauth");
  });

  it("未接続・再認可待ちなら freee を呼ばずに止める", async () => {
    const none: FreeeTokenStore = { ...fakeStore({ accessToken: "a", refreshToken: "r", expiresAt: 0 }).store, get: async () => null };
    await expect(getFreeeAccessToken(C, { store: none, refresh: vi.fn() })).rejects.toBeInstanceOf(FreeeNotConnectedError);
    const { s, store } = fakeStore({ accessToken: "a1", refreshToken: "r1", expiresAt: NOW - 1, status: "needs_reauth" });
    const refresh = fakeRefresh(s);
    await expect(getFreeeAccessToken(C, { store, refresh, now: () => NOW })).rejects.toBeInstanceOf(FreeeNeedsReauthError);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("force（freee が 401 を返した）なら、期限内でも更新する", async () => {
    const { s, store } = fakeStore({ accessToken: "a1", refreshToken: "r1", expiresAt: NOW + 3600 * 1000 });
    const t = await getFreeeAccessToken(C, { store, refresh: fakeRefresh(s), now: () => NOW }, { force: true });
    expect(t.accessToken).toBe("a2");
  });
});
