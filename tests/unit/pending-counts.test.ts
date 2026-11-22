import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadPendingCounts } from "@/lib/review/counts";

/** pending_transaction_counts を返す最小のクライアント（range 付きの select だけ） */
function fakeClient(result: { data: unknown[] | null; error: { message: string } | null }) {
  const query = {
    select: () => query,
    order: () => query,
    range: async (from: number) => (from === 0 ? result : { data: [], error: null }),
  };
  return { from: () => query } as unknown as SupabaseClient;
}

describe("loadPendingCounts", () => {
  it("DB で数えた件数を返す（1,000件を超える件数もそのまま）", async () => {
    const counts = await loadPendingCounts(
      fakeClient({
        data: [
          { customer_id: "c1", status: "new", count: 1205 },
          { customer_id: "c1", status: "duplicate_suspected", count: 3 },
        ],
        error: null,
      }),
    );
    expect(counts.get("c1", "new")).toBe(1205);
    expect(counts.get("c1", "duplicate_suspected")).toBe(3);
    expect(counts.get("c1", "on_hold")).toBe(0);
  });

  it("data: null かつ error なしの応答も 0 件として返さず、例外にする", async () => {
    await expect(loadPendingCounts(fakeClient({ data: null, error: null }))).rejects.toThrow(/件数の読込に失敗しました/);
  });

  it("読込に失敗したら 0 件として返さず、例外にする", async () => {
    await expect(loadPendingCounts(fakeClient({ data: null, error: { message: "permission denied" } }))).rejects.toThrow(
      /件数の読込に失敗しました/,
    );
  });
});
