import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { fetchAll } from "../supabase/fetch-all";

/** トップ画面に出す残件の区分 */
export const PENDING_STATUSES = ["proposed", "on_hold", "duplicate_suspected", "new"] as const;
export type PendingStatus = (typeof PENDING_STATUSES)[number];

export type PendingCounts = { get(customerId: string, status: PendingStatus): number };

/**
 * 顧客ごと・状態ごとの残件数。DB で数えたもの（pending_transaction_counts）を読むので、
 * 明細が 1,000 件を超えても欠けない。読めなければ例外にする（0 件として扱わない）。
 */
export async function loadPendingCounts(client: SupabaseClient): Promise<PendingCounts> {
  const rows = z
    .array(z.object({ customer_id: z.string(), status: z.string(), count: z.number().int().nonnegative() }))
    .parse(
      await fetchAll("件数", (from, to) =>
        client
          .from("pending_transaction_counts")
          .select("customer_id, status, count")
          .order("customer_id")
          .order("status")
          .range(from, to),
      ),
    );
  const map = new Map(rows.map((r) => [`${r.customer_id}:${r.status}`, r.count] as const));
  return { get: (customerId, status) => map.get(`${customerId}:${status}`) ?? 0 };
}
