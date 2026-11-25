import { NextResponse } from "next/server";
import { z } from "zod";
import { todayJst } from "@/lib/freee/admin";
import { freeeOAuthConfigFromEnv } from "@/lib/freee/oauth";
import { runFreeeSync } from "@/lib/freee/run";
import { createServiceClient } from "@/lib/supabase/server";

export const maxDuration = 300;

/**
 * freee の読み取り同期（接続済みの全顧客）。Authorization: Bearer CRON_SECRET のときだけ動く。
 * 本番の Cron は止めているため、vercel.json には登録していない（docs/deployment-hold.md）。書込はしない
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const service = createServiceClient();
  const oauth = freeeOAuthConfigFromEnv();
  const { data, error } = await service.from("freee_connections").select("customer_id").eq("status", "active");
  if (error) return NextResponse.json({ error: "接続の一覧を読めませんでした" }, { status: 500 });
  const ids = z.array(z.object({ customer_id: z.string() })).parse(data).map((r) => r.customer_id);
  const results: Record<string, unknown> = {};
  for (const customerId of ids) {
    try {
      const r = await runFreeeSync(customerId, { service, oauth, today: todayJst() });
      results[customerId] = { masters: r.results.masters.status, past_entries: r.results.past_entries.status, apiCalls: r.apiCalls };
    } catch {
      results[customerId] = { error: "同期の実行記録を残せませんでした" };
    }
  }
  return NextResponse.json({ customers: ids.length, results });
}
