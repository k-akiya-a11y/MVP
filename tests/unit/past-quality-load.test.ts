import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadPastQuality } from "@/lib/retrieval/past-quality-load";
import { PAGE_SIZE } from "@/lib/supabase/fetch-all";

const CID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

type Result = { data: unknown; error: { message: string } | null };
type Call = { table: string; select: string; eq: [string, unknown][]; order: string[]; range?: [number, number] };

/**
 * 呼出しを記録する最小のクライアント。pages は表ごとの応答（range の from に対する応答を順に返す）。
 * 実 DB・RLS は通らない。
 */
function fake(opts: { customer?: Result; past?: Result[]; masters?: Result[] }) {
  const calls: Call[] = [];
  const pages: Record<string, Result[]> = { past_journal_entries: opts.past ?? [], freee_masters: opts.masters ?? [] };
  const client = {
    from(table: string) {
      const call: Call = { table, select: "", eq: [], order: [] };
      calls.push(call);
      const q = {
        select: (s: string) => ((call.select = s), q),
        eq: (c: string, v: unknown) => (call.eq.push([c, v]), q),
        order: (c: string) => (call.order.push(c), q),
        maybeSingle: async () => opts.customer ?? { data: { id: CID, name: "テスト商事" }, error: null },
        range: async (from: number, to: number) => {
          call.range = [from, to];
          const list = pages[table] ?? [];
          const n = calls.filter((c) => c.table === table).length - 1;
          return list[n] ?? { data: [], error: null };
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const entry = (id: string, account: number, o: Record<string, unknown> = {}) => ({
  id,
  customer_id: CID,
  entry_date: "2026-01-10",
  direction: "expense",
  partner_key: "ACME",
  account_item_id: account,
  ...o,
});
const ok = (data: unknown): Result => ({ data, error: null });

describe("loadPastQuality", () => {
  it("UUID でない顧客IDは DB を読む前に拒否する", async () => {
    const f = fake({});
    await expect(loadPastQuality(f.client, "not-a-uuid")).rejects.toThrow(/顧客ID/);
    expect(f.calls).toHaveLength(0);
  });

  it("顧客が見えないときは null を返し、過去仕訳・マスタを読まない", async () => {
    const f = fake({ customer: ok(null) });
    await expect(loadPastQuality(f.client, CID)).resolves.toBeNull();
    expect(f.calls.map((c) => c.table)).toEqual(["customers"]);
  });

  it("顧客の読込エラーは例外にする", async () => {
    const f = fake({ customer: { data: null, error: { message: "boom" } } });
    await expect(loadPastQuality(f.client, CID)).rejects.toThrow(/顧客の読込に失敗/);
    expect(f.calls).toHaveLength(1);
  });

  it("customer_id を明示して絞り、必要な列だけを id 順にページ読込する", async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => entry(`id-${i}`, 100));
    const f = fake({
      past: [ok(full), ok([entry("last", 200)]), ok([])],
      masters: [ok([{ customer_id: CID, kind: "account_item", freee_id: "100", name: "消耗品費", available: true }]), ok([])],
    });
    const r = await loadPastQuality(f.client, CID);
    const past = f.calls.filter((c) => c.table === "past_journal_entries");
    expect(past.map((c) => c.range)).toEqual([
      [0, PAGE_SIZE - 1],
      [PAGE_SIZE, 2 * PAGE_SIZE - 1],
      [PAGE_SIZE + 1, 2 * PAGE_SIZE],
    ]);
    for (const c of past) {
      expect(c.select).toBe("id, customer_id, entry_date, direction, partner_key, account_item_id");
      expect(c.eq).toContainEqual(["customer_id", CID]);
      expect(c.order).toEqual(["id"]);
    }
    const masters = f.calls.filter((c) => c.table === "freee_masters");
    for (const c of masters) {
      expect(c.eq).toContainEqual(["customer_id", CID]);
      expect(c.eq).toContainEqual(["kind", "account_item"]);
      expect(c.eq.map(([k]) => k)).not.toContain("available");
    }
    expect(r?.report.totalEntries).toBe(PAGE_SIZE + 1);
    expect(r?.report.variantGroups).toHaveLength(1);
    expect(r?.accounts.get(100)).toEqual({ name: "消耗品費", available: true });
  });

  it("無効なマスタも名前を引け、マスタにない科目の仕訳も落とさない", async () => {
    const f = fake({
      past: [ok([entry("a", 100), entry("b", 999)])],
      masters: [ok([{ customer_id: CID, kind: "account_item", freee_id: 100, name: "旧科目", available: false }])],
    });
    const r = await loadPastQuality(f.client, CID);
    expect(r?.accounts.get(100)).toEqual({ name: "旧科目", available: false });
    expect(r?.accounts.has(999)).toBe(false);
    expect(r?.report.variantGroups[0]?.accounts.map((a) => a.accountItemId)).toEqual([100, 999]);
  });

  it("customers の data が undefined / 形式不正なら、見えない顧客（null）にせず例外にする", async () => {
    for (const data of [undefined, { id: CID }, "x"]) {
      const f = fake({ customer: { data, error: null } });
      await expect(loadPastQuality(f.client, CID)).rejects.toThrow();
      expect(f.calls.map((c) => c.table)).toEqual(["customers"]);
    }
  });

  it("要求と違う顧客が返ってきたら例外にし、過去仕訳を読まない", async () => {
    const f = fake({ customer: ok({ id: OTHER, name: "別会社" }) });
    await expect(loadPastQuality(f.client, CID)).rejects.toThrow(/一致しません/);
    expect(f.calls.map((c) => c.table)).toEqual(["customers"]);
  });

  it("マスタの科目IDが重複したら黙って上書きせず例外にする", async () => {
    const m = (name: string) => ({ customer_id: CID, kind: "account_item", freee_id: 100, name, available: true });
    const f = fake({ past: [ok([entry("a", 100)])], masters: [ok([m("甲"), m("乙")])] });
    await expect(loadPastQuality(f.client, CID)).rejects.toThrow(/マスタのIDが重複/);
  });

  it("他の顧客の行が混じっていたら拒否する（過去仕訳・マスタ）", async () => {
    await expect(loadPastQuality(fake({ past: [ok([entry("a", 1, { customer_id: OTHER })])] }).client, CID)).rejects.toThrow(/他の顧客/);
    await expect(
      loadPastQuality(
        fake({
          past: [ok([entry("a", 1)])],
          masters: [ok([{ customer_id: OTHER, kind: "account_item", freee_id: 1, name: "x", available: true }])],
        }).client,
        CID,
      ),
    ).rejects.toThrow(/他の顧客/);
  });

  it("ページの失敗・null・形式不正は成功した空結果にせず例外にする", async () => {
    const bad: Result[] = [
      { data: null, error: { message: "denied" } },
      { data: null, error: null },
      ok([entry("a", 1, { direction: "sideways" })]),
      ok([entry("a", 1, { account_item_id: null })]),
      ok([entry("a", 1, { entry_date: "2026/01/10" })]),
      ok([{ id: "a" }]),
    ];
    for (const page of bad) {
      await expect(loadPastQuality(fake({ past: [page] }).client, CID)).rejects.toThrow();
    }
    // 2ページ目で失敗したら、1ページ目の分だけを返さない
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => entry(`id-${i}`, 1));
    await expect(loadPastQuality(fake({ past: [ok(full), { data: null, error: { message: "x" } }] }).client, CID)).rejects.toThrow(
      /過去仕訳の読込に失敗/,
    );
    await expect(
      loadPastQuality(fake({ past: [ok([entry("a", 1)])], masters: [{ data: null, error: { message: "x" } }] }).client, CID),
    ).rejects.toThrow(/勘定科目マスタの読込に失敗/);
  });

  it("過去仕訳IDが重複して返ってきたら例外にする", async () => {
    const f = fake({ past: [ok([entry("a", 1), entry("a", 2)])] });
    await expect(loadPastQuality(f.client, CID)).rejects.toThrow(/重複/);
  });
});
