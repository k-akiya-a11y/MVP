import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/** freee 連携の画面のデータ。担当者の権限で読む（RLS で担当顧客だけ。トークン・Vault の ID は列の権限で読めない） */
export type FreeePageData = {
  customer: { name: string; freeeCompanyId: number | null };
  isAdmin: boolean;
  connection: { status: string; connectedAt: string } | null;
  state: {
    mastersSyncedAt: string | null;
    pastEntriesFrom: string | null;
    pastEntriesNextMonth: string | null;
    pastEntriesCompletedAt: string | null;
  } | null;
  runs: { id: string; kind: string; status: string; apiCalls: number; counts: unknown; error: string | null; startedAt: string }[];
};

const bigintish = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number).pipe(z.number().int().positive().safe());

/** 顧客が見えなければ null。読めなければ例外（画面は「読めなかった」と表示する） */
export async function loadFreeePage(client: SupabaseClient, customerId: string): Promise<FreeePageData | null> {
  const customer = await client.from("customers").select("name, freee_company_id").eq("id", customerId).maybeSingle();
  if (customer.error) throw new Error("顧客を読めませんでした");
  if (!customer.data) return null;
  const c = z.object({ name: z.string(), freee_company_id: bigintish.nullable() }).parse(customer.data);

  const [admin, conn, state, runs] = await Promise.all([
    client.rpc("is_admin"),
    client.from("freee_connections").select("status, connected_at").eq("customer_id", customerId).maybeSingle(),
    client
      .from("freee_sync_state")
      .select("masters_synced_at, past_entries_from, past_entries_next_month, past_entries_completed_at")
      .eq("customer_id", customerId)
      .maybeSingle(),
    client
      .from("freee_sync_runs")
      .select("id, kind, status, api_calls, counts, error, started_at")
      .eq("customer_id", customerId)
      .order("started_at", { ascending: false })
      .limit(20),
  ]);
  for (const r of [admin, conn, state, runs]) if (r.error) throw new Error("freee 連携の状態を読めませんでした");

  const connection = z.object({ status: z.string(), connected_at: z.string() }).nullable().parse(conn.data);
  const s = z
    .object({
      masters_synced_at: z.string().nullable(),
      past_entries_from: z.string().nullable(),
      past_entries_next_month: z.string().nullable(),
      past_entries_completed_at: z.string().nullable(),
    })
    .nullable()
    .parse(state.data);
  const runRows = z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        status: z.string(),
        api_calls: z.number().int(),
        counts: z.unknown(),
        error: z.string().nullable(),
        started_at: z.string(),
      }),
    )
    .parse(runs.data);
  return {
    customer: { name: c.name, freeeCompanyId: c.freee_company_id },
    isAdmin: admin.data === true,
    connection: connection ? { status: connection.status, connectedAt: connection.connected_at } : null,
    state: s
      ? {
          mastersSyncedAt: s.masters_synced_at,
          pastEntriesFrom: s.past_entries_from,
          pastEntriesNextMonth: s.past_entries_next_month,
          pastEntriesCompletedAt: s.past_entries_completed_at,
        }
      : null,
    runs: runRows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      apiCalls: r.api_calls,
      counts: r.counts,
      error: r.error,
      startedAt: r.started_at,
    })),
  };
}
