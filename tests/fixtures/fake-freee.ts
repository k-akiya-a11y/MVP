import type { FetchLike } from "@/lib/freee/api";

/**
 * テスト用の偽の freee（本物の freee は呼ばない）。URL の path ごとに応答を返し、呼ばれた要求を記録する。
 * データはすべて架空。
 */
export type FakeCall = { method: string; url: URL; headers: Record<string, string>; body: string | null };

export function fakeFreee(routes: Record<string, (url: URL, call: FakeCall) => { status?: number; body: unknown }>) {
  const calls: FakeCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call: FakeCall = { method: init?.method ?? "GET", url, headers, body: typeof init?.body === "string" ? init.body : null };
    calls.push(call);
    const route = routes[url.pathname];
    if (!route) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    const { status = 200, body } = route(url, call);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, calls };
}

/** offset/limit で切り出す */
export function page<T>(url: URL, all: T[]): T[] {
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? all.length);
  return all.slice(offset, offset + limit);
}
