import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// @supabase/ssr だけをモックする。getUser の中で cookies.setAll を呼び、実物と同じ順序を再現する
type CookieToSet = {
  name: string;
  value: string;
  options: {
    path?: string;
    maxAge?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "lax" | "strict" | "none";
  };
};
type CookieAdapter = {
  getAll: () => { name: string; value: string }[];
  setAll: (list: CookieToSet[], headers: Record<string, string>) => void;
};
type SetAllCall = { cookies: CookieToSet[]; headers: Record<string, string> };

const { state, createServerClientMock } = vi.hoisted(() => {
  const state = {
    user: null as { id: string } | null,
    cookiesToSet: [] as unknown[],
    // 指定があれば、この順に setAll を複数回呼ぶ（実物の SetAllCookies の第二引数を再現する）
    calls: [] as unknown[],
  };
  const createServerClientMock = vi.fn(
    (_url: string, _key: string, opts: { cookies: unknown }) => ({
      auth: {
        getUser: async () => {
          const adapter = opts.cookies as CookieAdapter;
          adapter.getAll();
          if (state.calls.length > 0) {
            for (const call of state.calls as SetAllCall[]) adapter.setAll(call.cookies, call.headers);
          } else if (state.cookiesToSet.length > 0) {
            adapter.setAll(state.cookiesToSet as CookieToSet[], {});
          }
          return { data: { user: state.user } };
        },
      },
    }),
  );
  return { state, createServerClientMock };
});
vi.mock("@supabase/ssr", () => ({ createServerClient: createServerClientMock }));

import { middleware } from "@/middleware";

// 合成の Cookie（実際のセッションではない）。期限切れの削除と、更新の2種類
const EXPIRED: CookieToSet = {
  name: "sb-synthetic-auth-token",
  value: "",
  options: { path: "/", maxAge: 0, httpOnly: true, secure: true, sameSite: "lax" },
};
const REFRESHED: CookieToSet = {
  name: "sb-synthetic-auth-token.1",
  value: "synthetic-refreshed-value",
  options: { path: "/", maxAge: 3600, httpOnly: true, secure: true, sameSite: "strict" },
};

function req(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: { cookie: "sb-synthetic-auth-token=synthetic-old-value" },
  });
}

function expectCookie(res: Response & { cookies: NextResponseCookies }, c: CookieToSet) {
  expect(res.cookies.get(c.name)).toMatchObject({
    name: c.name,
    value: c.value,
    path: c.options.path,
    maxAge: c.options.maxAge,
    httpOnly: c.options.httpOnly,
    secure: c.options.secure,
    sameSite: c.options.sameSite,
  });
}
// 最終的な Set-Cookie ヘッダーが、削除（Max-Age=0）と更新の2個別 Cookie になっていること
function expectSetCookieHeaders(res: Response) {
  const headers = res.headers.getSetCookie();
  expect(headers).toHaveLength(2);
  const expired = headers.find((h) => h.startsWith(`${EXPIRED.name}=`));
  const refreshed = headers.find((h) => h.startsWith(`${REFRESHED.name}=`));
  expect(expired).toMatch(/Max-Age=0/i);
  expect(refreshed).toMatch(/Max-Age=3600/i);
}
type NextResponseCookies =Awaited<ReturnType<typeof middleware>>["cookies"];

// @supabase/ssr の SetAllCookies 第二引数（types.d.ts と cookies.js の applyServerStorage の契約）。
// 最初の書き込みにだけ付き、同じクライアントの以降の呼び出しでは {} になる
const CACHE_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  Expires: "0",
  Pragma: "no-cache",
};
function expectCacheHeaders(res: Response) {
  expect(res.headers.get("cache-control")).toBe(CACHE_HEADERS["Cache-Control"]);
  expect(res.headers.get("expires")).toBe("0");
  expect(res.headers.get("pragma")).toBe("no-cache");
}

// 経路ごとの準備と共通の確認（next / 未認証ページの転送 / 未認証 API の 401）
const ROUTES = [
  {
    label: "next",
    path: "/customers/c1",
    authed: true,
    expectRoute: (res: Response) => {
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    },
  },
  {
    label: "redirect",
    path: "/customers/c1?secret=synthetic",
    authed: false,
    expectRoute: (res: Response) => {
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost/login");
    },
  },
  {
    label: "API 401",
    path: "/api/customers/c1/statements",
    authed: false,
    expectRoute: (res: Response) => {
      expect(res.status).toBe(401);
    },
  },
];

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.invalid");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key-not-real");
  state.user = null;
  state.cookiesToSet = [];
  state.calls = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("middleware: getUser 内で setAll が返した Cookie の保持", () => {
  it("未認証のページはクエリなしの /login へ転送され、削除・更新 Cookie と属性が残る", async () => {
    state.cookiesToSet = [EXPIRED, REFRESHED];
    const res = await middleware(req("/customers/c1?secret=synthetic"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/login");
    expectCookie(res, EXPIRED);
    expectCookie(res, REFRESHED);
    expectSetCookieHeaders(res);
  });

  it("未認証の API は 401 の固定 JSON を返し、削除・更新 Cookie と属性が残る", async () => {
    state.cookiesToSet = [EXPIRED, REFRESHED];
    const res = await middleware(req("/api/customers/c1/statements"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "ログインしてください" });
    expectCookie(res, EXPIRED);
    expectCookie(res, REFRESHED);
    expectSetCookieHeaders(res);
  });

  it("認証済みは next で通り、更新 Cookie が応答に載る（現状でも成立する想定）", async () => {
    state.user = { id: "synthetic-user" };
    state.cookiesToSet = [REFRESHED];
    const res = await middleware(req("/customers/c1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("location")).toBeNull();
    expectCookie(res, REFRESHED);
  });

  it("Cookie の更新がなければ、どの経路も Set-Cookie を付けず、転送先・401 は変わらない", async () => {
    const redirect = await middleware(req("/customers/c1?x=1"));
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("http://localhost/login");
    expect(redirect.headers.getSetCookie()).toEqual([]);

    const api = await middleware(req("/api/anything"));
    expect(api.status).toBe(401);
    expect(api.headers.getSetCookie()).toEqual([]);

    state.user = { id: "synthetic-user" };
    const ok = await middleware(req("/customers/c1"));
    expect(ok.headers.get("x-middleware-next")).toBe("1");
    expect(ok.headers.getSetCookie()).toEqual([]);

    // 公開パスは未認証でも通る（規則は変えない）
    state.user = null;
    const pub = await middleware(req("/login"));
    expect(pub.headers.get("x-middleware-next")).toBe("1");
    expect(pub.headers.getSetCookie()).toEqual([]);
  });
});

describe("middleware: SetAllCookies の第二引数（キャッシュ禁止ヘッダー）の保持", () => {
  for (const route of ROUTES) {
    it(`${route.label}: setAll 1 回でも Cookie と Cache-Control / Expires / Pragma が残る`, async () => {
      state.user = route.authed ? { id: "synthetic-user" } : null;
      state.calls = [{ cookies: [EXPIRED, REFRESHED], headers: CACHE_HEADERS }];
      const res = await middleware(req(route.path));

      route.expectRoute(res);
      expectCookie(res, EXPIRED);
      expectCookie(res, REFRESHED);
      expectCacheHeaders(res);
    });

    it(`${route.label}: setAll が複数回（最初のみ headers、2 回目は {}）でも最初の Cookie と 3 ヘッダーが消えない`, async () => {
      state.user = route.authed ? { id: "synthetic-user" } : null;
      state.calls = [
        { cookies: [EXPIRED], headers: CACHE_HEADERS },
        { cookies: [REFRESHED], headers: {} },
      ];
      const res = await middleware(req(route.path));

      route.expectRoute(res);
      expectCookie(res, EXPIRED);
      expectCookie(res, REFRESHED);
      expectCacheHeaders(res);
      expectSetCookieHeaders(res);
    });
  }

  it("ヘッダー名は大小文字を区別せず受け取り、キャッシュ禁止の 3 つ以外の任意ヘッダーは写さない", async () => {
    state.calls = [
      {
        cookies: [REFRESHED],
        headers: {
          "cache-control": CACHE_HEADERS["Cache-Control"],
          EXPIRES: "0",
          pragma: "no-cache",
          "X-Arbitrary": "synthetic",
          "x-middleware-next": "1",
        },
      },
    ];
    for (const path of ["/customers/c1", "/api/customers/c1/statements"]) {
      const res = await middleware(req(path));
      expectCacheHeaders(res);
      expect(res.headers.get("x-arbitrary")).toBeNull();
      expect(res.headers.get("x-middleware-next")).toBeNull();
    }
  });

  it("内部の x-middleware-next は redirect / 401 に出ず、next にだけ付く", async () => {
    state.calls = [{ cookies: [REFRESHED], headers: CACHE_HEADERS }];
    const redirect = await middleware(req("/customers/c1"));
    expect(redirect.headers.get("x-middleware-next")).toBeNull();
    const api = await middleware(req("/api/customers/c1/statements"));
    expect(api.headers.get("x-middleware-next")).toBeNull();

    state.user = { id: "synthetic-user" };
    const ok = await middleware(req("/customers/c1"));
    expect(ok.headers.get("x-middleware-next")).toBe("1");
  });

  it("同名 Cookie は最後の setAll が勝ち（大小文字違いの名前は別 Cookie）、どの経路でも 1 件だけ出る", async () => {
    const first: CookieToSet = { ...REFRESHED, value: "synthetic-first" };
    const last: CookieToSet = { ...REFRESHED, value: "synthetic-last" };
    const otherCase: CookieToSet = { ...REFRESHED, name: REFRESHED.name.toUpperCase(), value: "synthetic-case" };
    for (const route of ROUTES) {
      state.user = route.authed ? { id: "synthetic-user" } : null;
      state.calls = [
        { cookies: [first, otherCase], headers: CACHE_HEADERS },
        { cookies: [last], headers: {} },
      ];
      const res = await middleware(req(route.path));

      route.expectRoute(res);
      expectCookie(res, last);
      expectCookie(res, otherCase);
      const same = res.headers.getSetCookie().filter((h) => h.startsWith(`${REFRESHED.name}=`));
      expect(same).toHaveLength(1);
      expect(same[0]).toContain("synthetic-last");
      expect(res.headers.getSetCookie()).toHaveLength(2);
    }
  });

  it("request の Cookie も更新される（次の処理へ渡す next 応答に反映）", async () => {
    state.user = { id: "synthetic-user" };
    const request = req("/customers/c1");
    state.calls = [
      { cookies: [EXPIRED], headers: CACHE_HEADERS },
      { cookies: [{ ...REFRESHED, name: EXPIRED.name, value: "synthetic-new" }], headers: {} },
    ];
    await middleware(request);
    expect(request.cookies.get(EXPIRED.name)?.value).toBe("synthetic-new");
  });

  it("headers が空（Cookie の更新なし）の経路には、キャッシュ禁止ヘッダーを足さない", async () => {
    state.calls = [{ cookies: [REFRESHED], headers: {} }];
    const res = await middleware(req("/customers/c1"));

    expect(res.headers.get("location")).toBe("http://localhost/login");
    expect(res.headers.get("cache-control")).toBeNull();
    expect(res.headers.get("expires")).toBeNull();
    expect(res.headers.get("pragma")).toBeNull();
  });
});
