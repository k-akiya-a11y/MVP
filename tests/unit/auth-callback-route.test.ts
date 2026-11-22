import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 実 Supabase に接続しないよう、route より先にクライアント生成をモックする
const { createUserClientMock } = vi.hoisted(() => ({ createUserClientMock: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createUserClient: createUserClientMock,
}));

import { GET } from "@/app/auth/callback/route";

// テスト専用の架空の値（実在のドメイン・アカウント・トークンではない）
const ORIGIN = "https://app.example.test";
const DOMAIN = "example.com";
const USER_ID = "user-0001-not-real";
const LEAK = "internal-secret-detail-not-real";

type AuthUser = { id: string; email?: string | null };
type AuthError = { message: string };
type ExchangeResult = { data: { user: AuthUser | null }; error: AuthError | null };
type StaffResult = { data: { user_id: string } | null; error: AuthError | null };

type Mocks = {
  exchange: ReturnType<typeof vi.fn<(code: string) => Promise<ExchangeResult>>>;
  signOut: ReturnType<typeof vi.fn<() => Promise<{ error: null }>>>;
  from: ReturnType<typeof vi.fn<(table: string) => unknown>>;
  select: ReturnType<typeof vi.fn<(columns: string) => unknown>>;
  eq: ReturnType<typeof vi.fn<(column: string, value: string) => unknown>>;
  maybeSingle: ReturnType<typeof vi.fn<() => Promise<StaffResult>>>;
};

function setup(options: { exchange?: ExchangeResult; staff?: StaffResult } = {}): Mocks {
  const exchange = vi.fn<(code: string) => Promise<ExchangeResult>>();
  exchange.mockResolvedValue(
    options.exchange ?? { data: { user: { id: USER_ID, email: `staff@${DOMAIN}` } }, error: null },
  );
  const signOut = vi.fn<() => Promise<{ error: null }>>();
  signOut.mockResolvedValue({ error: null });
  const maybeSingle = vi.fn<() => Promise<StaffResult>>();
  maybeSingle.mockResolvedValue(options.staff ?? { data: { user_id: USER_ID }, error: null });
  const eq = vi.fn<(column: string, value: string) => unknown>();
  eq.mockReturnValue({ maybeSingle });
  const select = vi.fn<(columns: string) => unknown>();
  select.mockReturnValue({ eq });
  const from = vi.fn<(table: string) => unknown>();
  from.mockReturnValue({ select });
  createUserClientMock.mockResolvedValue({ auth: { exchangeCodeForSession: exchange, signOut }, from });
  return { exchange, signOut, from, select, eq, maybeSingle };
}

function req(query: string): Request {
  return new Request(`${ORIGIN}/auth/callback${query}`);
}

function exchangeWithEmail(email: string | null | undefined): ExchangeResult {
  return { data: { user: { id: USER_ID, email } }, error: null };
}

function expectRedirect(res: Response, path: string) {
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe(`${ORIGIN}${path}`);
}

beforeEach(() => {
  vi.stubEnv("ALLOWED_LOGIN_DOMAIN", DOMAIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetAllMocks();
});

describe("GET /auth/callback のコード検証", () => {
  it("code が無ければクライアントを作らず failed に戻す", async () => {
    const m = setup();
    expectRedirect(await GET(req("")), "/login?error=failed");
    expectRedirect(await GET(req("?code=")), "/login?error=failed");
    expect(createUserClientMock).not.toHaveBeenCalled();
    expect(m.exchange).not.toHaveBeenCalled();
    expect(m.signOut).not.toHaveBeenCalled();
    expect(m.from).not.toHaveBeenCalled();
  });

  it("セッション交換がエラーなら failed。担当者の照会もしない", async () => {
    const m = setup({ exchange: { data: { user: null }, error: { message: LEAK } } });
    const res = await GET(req("?code=abc"));
    expectRedirect(res, "/login?error=failed");
    expect(m.exchange).toHaveBeenCalledWith("abc");
    expect(m.from).not.toHaveBeenCalled();
  });

  it("エラーが無くてもユーザーが無ければ failed", async () => {
    const m = setup({ exchange: { data: { user: null }, error: null } });
    expectRedirect(await GET(req("?code=abc")), "/login?error=failed");
    expect(m.from).not.toHaveBeenCalled();
  });
});

describe("GET /auth/callback のドメイン検証", () => {
  it("ALLOWED_LOGIN_DOMAIN が未設定・空なら signOut して domain で拒否する", async () => {
    for (const value of [undefined, ""]) {
      vi.stubEnv("ALLOWED_LOGIN_DOMAIN", value);
      const m = setup();
      expectRedirect(await GET(req("?code=abc")), "/login?error=domain");
      expect(m.signOut).toHaveBeenCalledTimes(1);
      expect(m.from).not.toHaveBeenCalled();
    }
  });

  it("メールが無い（null・undefined）なら signOut して domain で拒否する", async () => {
    for (const email of [null, undefined, ""]) {
      const m = setup({ exchange: exchangeWithEmail(email) });
      expectRedirect(await GET(req("?code=abc")), "/login?error=domain");
      expect(m.signOut).toHaveBeenCalledTimes(1);
      expect(m.from).not.toHaveBeenCalled();
    }
  });

  it("他ドメイン・サブドメイン・接尾辞の紛らわしいメールは拒否して担当者を照会しない", async () => {
    const attacks = [
      "staff@other.test",
      "staff@sub.example.com",
      "staff@notexample.com",
      "staff@example.com.evil.test",
      "staff@example.com@evil.test",
      "staff.example.com",
      `example.com`,
    ];
    for (const email of attacks) {
      const m = setup({ exchange: exchangeWithEmail(email) });
      expectRedirect(await GET(req("?code=abc")), "/login?error=domain");
      expect(m.signOut, email).toHaveBeenCalledTimes(1);
      expect(m.from, email).not.toHaveBeenCalled();
    }
  });

  it("拒否のリダイレクトは signOut の完了を待ってから返す", async () => {
    const m = setup({ exchange: exchangeWithEmail("staff@other.test") });
    let release: () => void = () => undefined;
    m.signOut.mockImplementation(
      () =>
        new Promise<{ error: null }>((resolve) => {
          release = () => resolve({ error: null });
        }),
    );

    let settled = false;
    const pending = GET(req("?code=abc")).then((res) => {
      settled = true;
      return res;
    });
    await vi.waitFor(() => expect(m.signOut).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release();
    expectRedirect(await pending, "/login?error=domain");
    expect(settled).toBe(true);
  });
});

describe("GET /auth/callback の担当者確認", () => {
  it("ドメインが完全一致（大文字小文字を区別しない）で担当者なら / に進む", async () => {
    const cases: Array<{ email: string; domain: string }> = [
      { email: `staff@${DOMAIN}`, domain: DOMAIN },
      { email: "Staff@EXAMPLE.COM", domain: DOMAIN },
      { email: "staff@example.com", domain: "Example.COM" },
    ];
    for (const c of cases) {
      vi.stubEnv("ALLOWED_LOGIN_DOMAIN", c.domain);
      const m = setup({ exchange: exchangeWithEmail(c.email) });
      expectRedirect(await GET(req("?code=abc")), "/");
      expect(m.signOut).not.toHaveBeenCalled();
    }
  });

  it("staff_members を認証済みユーザー自身の id だけで1回照会する", async () => {
    const m = setup();
    await GET(req("?code=abc&user_id=other-user&id=other-user"));
    expect(m.from).toHaveBeenCalledTimes(1);
    expect(m.from).toHaveBeenCalledWith("staff_members");
    expect(m.select).toHaveBeenCalledWith("user_id");
    expect(m.eq).toHaveBeenCalledTimes(1);
    expect(m.eq).toHaveBeenCalledWith("user_id", USER_ID);
    expect(m.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("担当者が未登録（data なし）なら signOut して not_staff", async () => {
    const m = setup({ staff: { data: null, error: null } });
    expectRedirect(await GET(req("?code=abc")), "/login?error=not_staff");
    expect(m.signOut).toHaveBeenCalledTimes(1);
  });

  it("照会がエラーで data が無ければ signOut して not_staff。内部エラーを出さない", async () => {
    const m = setup({ staff: { data: null, error: { message: LEAK } } });
    const res = await GET(req("?code=abc"));
    expectRedirect(res, "/login?error=not_staff");
    expect(m.signOut).toHaveBeenCalledTimes(1);
    expect(res.headers.get("location")).not.toContain(LEAK);
  });
});

describe("GET /auth/callback のリダイレクト先と情報漏えい", () => {
  it("next に外部 URL があっても無視し、自分のオリジンの / に進む", async () => {
    const targets = [
      "https://evil.test/",
      "//evil.test/",
      "/\\evil.test",
      "javascript:alert(1)",
      "/admin",
    ];
    for (const next of targets) {
      setup();
      const res = await GET(req(`?code=abc&next=${encodeURIComponent(next)}`));
      expectRedirect(res, "/");
    }
  });

  it("失敗時も next を無視し、自分のオリジンのログイン画面に戻す", async () => {
    setup({ exchange: exchangeWithEmail("staff@other.test") });
    const res = await GET(req(`?code=abc&next=${encodeURIComponent("https://evil.test/")}`));
    expectRedirect(res, "/login?error=domain");
  });

  it("失敗の応答に内部エラー・code・メールアドレスを含めない", async () => {
    const code = "code-value-not-real";
    const email = "someone@other.test";
    const scenarios: Array<{ options: Parameters<typeof setup>[0]; query: string }> = [
      { options: { exchange: { data: { user: null }, error: { message: LEAK } } }, query: `?code=${code}` },
      { options: { exchange: exchangeWithEmail(email) }, query: `?code=${code}` },
      { options: { staff: { data: null, error: { message: LEAK } } }, query: `?code=${code}` },
      { options: { exchange: exchangeWithEmail(email), staff: { data: null, error: null } }, query: `?code=${code}` },
    ];
    for (const s of scenarios) {
      setup(s.options);
      const res = await GET(req(s.query));
      const text = `${res.headers.get("location") ?? ""}\n${await res.text()}`;
      for (const secret of [LEAK, code, email, USER_ID]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
