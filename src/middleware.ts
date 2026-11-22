import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// ログインなしで開けるパス（Cron は CRON_SECRET で別に守る）
const PUBLIC_PATHS = ["/login", "/auth/callback", "/api/cron/"];

// setAll の第二引数のうち、応答へ付けるキャッシュ禁止ヘッダー（HTTP のヘッダー名は大小文字を区別しない）
const CACHE_HEADERS = new Set(["cache-control", "expires", "pragma"]);

type CookieOptions = Parameters<NextResponse["cookies"]["set"]>[2];
type Pending = {
  // Cookie 名は大小文字を区別する。同名は最後の setAll が勝つ
  cookies: Map<string, { name: string; value: string; options?: CookieOptions }>;
  headers: Map<string, string>;
};

/** setAll が返した Cookie とキャッシュ禁止ヘッダーを、新しく作った応答へ写す。内部ヘッダーや任意ヘッダーは写さない */
function applyPending(pending: Pending, to: NextResponse): NextResponse {
  for (const { name, value, options } of pending.cookies.values()) {
    to.cookies.set(name, value, options);
  }
  for (const [name, value] of pending.headers) to.headers.set(name, value);
  return to;
}

/** セッションを更新し、未ログインならログイン画面へ送る */
export async function middleware(request: NextRequest) {
  const pending: Pending = { cookies: new Map(), headers: new Map() };
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.next({ request });

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list, headers) => {
        for (const { name, value, options } of list) {
          request.cookies.set(name, value);
          pending.cookies.delete(name); // 後勝ち（出力順も最後の更新に合わせる）
          pending.cookies.set(name, { name, value, options });
        }
        for (const [name, value] of Object.entries(headers ?? {})) {
          if (CACHE_HEADERS.has(name.toLowerCase())) pending.headers.set(name.toLowerCase(), value);
        }
      },
    },
  });
  const { data } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  if (!data.user && !PUBLIC_PATHS.some((p) => path.startsWith(p))) {
    if (path.startsWith("/api/")) {
      return applyPending(
        pending,
        NextResponse.json({ error: "ログインしてください" }, { status: 401 }),
      );
    }
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    return applyPending(pending, NextResponse.redirect(login));
  }
  // request.cookies の更新を反映した next 応答を、最後に一度だけ作る
  return applyPending(pending, NextResponse.next({ request }));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
