import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { JournalAi } from "@/lib/ai/client";
import { runProposalJob } from "@/lib/proposals/run";
import { supabaseProposalStore } from "@/lib/proposals/store";

// 仕訳候補作成が DB の応答から読む整数の境界（docs/reviews/2026-11-06-proposal-numeric-boundary.md）。
// 数値は安全な整数、文字列は /^-?[0-9]+$/ の 10 進だけを通す。null・空文字・空白・真偽値・配列などを 0 / 1 に変換しない。
// 値域（正の数など）の規則は作らない。実際の supabaseProposalStore を通し、client だけを差し替える。

const invalidInts: unknown[] = [
  "",
  "   ",
  true,
  false,
  [],
  [1],
  ["1"],
  {},
  1.5,
  "1.5",
  "1.0",
  "1e3",
  "1E3",
  "0x10",
  "+5",
  " 12 ",
  "12 ",
  "1_000",
  "１２",
  "-",
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  "9007199254740993",
];

type Row = Record<string, unknown>;
type ContextRows = {
  customer: Row;
  masters: Row[];
  rules: Row[];
  notes: Row[];
  past: Row[];
  wallets: Row[];
};

const baseRows = (): ContextRows => ({
  customer: { id: "c1", name: "テスト顧客", tax_method: "general", invoice_registered: true, low_confidence_amount_threshold: 300000 },
  masters: [{ kind: "account_item", freee_id: 101, name: "消耗品費", attrs: {} }],
  rules: [
    {
      rule_id: "r1",
      version: 1,
      priority: 10,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      cond_partner_key: null,
      cond_description_keyword: null,
      cond_amount_min: null,
      cond_amount_max: null,
      cond_wallet_id: null,
      cond_direction: null,
      account_item_id: 101,
      tax_code: 21,
      partner_id: null,
      item_id: null,
      section_id: null,
      tag_ids: [],
      description_template: null,
      valid_from: null,
      valid_to: null,
    },
  ],
  notes: [{ note_id: "n1", version: 1, status: "active", title: "メモ", body: "本文" }],
  past: [
    {
      id: "p1",
      entry_date: "2026-01-10",
      amount: 1000,
      direction: "expense",
      bank_description: null,
      partner_key: null,
      account_item_id: 101,
      tax_code: 21,
      partner_id: null,
      item_id: null,
      section_id: null,
      tag_ids: [],
      description: null,
    },
  ],
  wallets: [{ id: "w1", name: "普通預金" }],
});

const TABLES: Record<string, keyof Omit<ContextRows, "customer">> = {
  freee_masters: "masters",
  current_journal_rules: "rules",
  current_customer_notes: "notes",
  past_journal_entries: "past",
  wallets: "wallets",
};

/** 先頭の要素を実行時に確認して返す（空なら失敗させ、undefined を型にも実行にも持ち込まない） */
function first<T>(items: readonly T[], label = "配列"): T {
  const head = items[0];
  if (head === undefined) throw new Error(`${label}の先頭要素がありません`);
  return head;
}

/** 表ごとの行を返す、流れるように繋ぐクエリビルダーの代用。range を実際に適用するので fetchAll が終端まで読める */
function contextClient(rows: ContextRows, rpc: (name: string, args: unknown) => unknown = () => ({ data: null, error: null })) {
  return {
    rpc: async (name: string, args: unknown) => rpc(name, args),
    from(table: string) {
      let range: [number, number] | null = null;
      const run = () => {
        if (table === "customers") return { data: rows.customer, error: null };
        const key = TABLES[table];
        if (key === undefined) throw new Error(`未対応の表です: ${table}`);
        const all = rows[key];
        return { data: range ? all.slice(range[0], range[1] + 1) : all, error: null };
      };
      const builder: Record<string, unknown> = {
        then: (resolve: (v: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve),
      };
      for (const method of ["select", "eq", "order", "gte", "lte", "single"]) builder[method] = () => builder;
      builder.range = (from: number, to: number) => {
        range = [from, to];
        return builder;
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const load = (rows: ContextRows) => supabaseProposalStore(contextClient(rows)).loadCustomerContext("c1", "2026-11-06");

type Position = { name: string; nullable: boolean; set: (rows: ContextRows, value: unknown) => void };

const contextPositions: Position[] = [
  { name: "顧客 low_confidence_amount_threshold", nullable: false, set: (r, v) => void (r.customer.low_confidence_amount_threshold = v) },
  { name: "マスタ freee_id", nullable: false, set: (r, v) => void (first(r.masters).freee_id = v) },
  { name: "過去仕訳 amount", nullable: false, set: (r, v) => void (first(r.past).amount = v) },
  { name: "過去仕訳 tax_code", nullable: false, set: (r, v) => void (first(r.past).tax_code = v) },
  { name: "過去仕訳 partner_id（任意）", nullable: true, set: (r, v) => void (first(r.past).partner_id = v) },
  { name: "過去仕訳 tag_ids の要素", nullable: false, set: (r, v) => void (first(r.past).tag_ids = [v]) },
  { name: "ルール cond_amount_min（任意）", nullable: true, set: (r, v) => void (first(r.rules).cond_amount_min = v) },
  { name: "ルール tax_code", nullable: false, set: (r, v) => void (first(r.rules).tax_code = v) },
  { name: "ルール tag_ids の要素", nullable: false, set: (r, v) => void (first(r.rules).tag_ids = [v]) },
  { name: "ルール version", nullable: false, set: (r, v) => void (first(r.rules).version = v) },
  { name: "ルール priority", nullable: false, set: (r, v) => void (first(r.rules).priority = v) },
  { name: "メモ version", nullable: false, set: (r, v) => void (first(r.notes).version = v) },
];

/** 受理されてしまった値を集める（失敗メッセージに一覧で出す） */
async function accepted(values: unknown[], attempt: (value: unknown) => Promise<unknown>): Promise<string[]> {
  const out: string[] = [];
  for (const value of values) {
    const ok = await attempt(value).then(
      () => true,
      () => false,
    );
    if (ok) out.push(typeof value === "number" ? String(value) : JSON.stringify(value) ?? String(value));
  }
  return out;
}

describe("supabaseProposalStore の数値境界: 不正な値を拒否する", () => {
  it("claimPendingBatch: 明細の amount", async () => {
    const claim = (amount: unknown) =>
      supabaseProposalStore({
        rpc: async () => ({
          data: [{ id: "t1", customer_id: "c1", wallet_id: "w1", txn_date: "2026-11-05", amount, direction: "expense", description: "テスト" }],
          error: null,
        }),
      } as unknown as SupabaseClient).claimPendingBatch(1);

    expect(await accepted([null, ...invalidInts], claim)).toEqual([]);
  });

  it.each(contextPositions)("loadCustomerContext: $name", async ({ set, nullable }) => {
    const attempt = async (value: unknown) => {
      const rows = baseRows();
      set(rows, value);
      return load(rows);
    };

    expect(await accepted(nullable ? invalidInts : [null, ...invalidInts], attempt)).toEqual([]);
  });
});

describe("supabaseProposalStore の数値境界: 正常な値は従来どおり通る", () => {
  it("整数の数値と 10 進の整数文字列を数値として読み、tax_code 0・負の過去金額・任意項目の null・空の tag_ids を保つ", async () => {
    const rows = baseRows();
    rows.customer.low_confidence_amount_threshold = "300000";
    first(rows.masters).freee_id = "101";
    rows.past[0] = { ...first(rows.past), amount: "-300", tax_code: 0, partner_id: null, tag_ids: [] };
    rows.rules[0] = { ...first(rows.rules), version: "2", priority: 10, tax_code: "0", cond_amount_min: null, cond_amount_max: "5000", tag_ids: ["7", 8] };
    first(rows.notes).version = "3";

    const ctx = await load(rows);
    const pastEntry = first(ctx.pastEntries);
    const rule = first(ctx.activeRules);

    expect(ctx.customer.lowConfidenceAmountThreshold).toBe(300000);
    expect(first(ctx.masters).id).toBe(101);
    expect(pastEntry.amount).toBe(-300);
    expect(pastEntry.entry).toMatchObject({ taxCode: 0, partnerId: null, tagIds: [] });
    expect(rule).toMatchObject({ version: 2, priority: 10 });
    expect(rule.cond).toMatchObject({ amountMin: null, amountMax: 5000 });
    expect(rule.action).toMatchObject({ taxCode: 0, tagIds: [7, 8] });
    expect(first(ctx.notes).version).toBe(3);
  });

  it("claimPendingBatch は数値と 10 進の整数文字列の amount を数値で返す", async () => {
    const claim = async (amount: unknown) =>
      supabaseProposalStore({
        rpc: async () => ({
          data: [{ id: "t1", customer_id: "c1", wallet_id: "w1", txn_date: "2026-11-05", amount, direction: "expense", description: "テスト" }],
          error: null,
        }),
      } as unknown as SupabaseClient).claimPendingBatch(1);

    expect(first(await claim(12000)).amount).toBe(12000);
    expect(first(await claim("12000")).amount).toBe(12000);
  });

  it("-0 と \"-0\" は 0 にする（-0 を残さない）", async () => {
    const rows = baseRows();
    first(rows.past).amount = -0;
    first(rows.rules).tax_code = "-0";

    const ctx = await load(rows);

    expect(Object.is(first(ctx.pastEntries).amount, 0)).toBe(true);
    expect(Object.is(first(ctx.activeRules).action.taxCode, 0)).toBe(true);
  });
});

describe("runProposalJob: 不正な数値の文脈では AI を呼ばず、借りた明細を返す", () => {
  const claimRow = (amount: unknown) => ({
    id: "t1",
    customer_id: "c1",
    wallet_id: "w1",
    txn_date: "2026-11-05",
    amount,
    direction: "expense",
    description: "テスト",
  });

  it("顧客のしきい値が不正なら、AI も判断の記録もせず、失敗に数え、借りた明細の貸出しを返す", async () => {
    const rows = baseRows();
    rows.customer.low_confidence_amount_threshold = null;
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let claimed = false;
    const client = contextClient(rows, (name, args) => {
      calls.push({ name, args: args as Record<string, unknown> });
      if (name === "claim_pending_proposal_batch") {
        const data = claimed ? [] : [claimRow(12000)];
        claimed = true;
        return { data, error: null };
      }
      return { data: null, error: null };
    });
    const ai = vi.fn() as unknown as JournalAi;

    const result = await runProposalJob({ store: supabaseProposalStore(client, "owner-1"), ai, today: "2026-11-06" });

    expect(ai).not.toHaveBeenCalled();
    expect(calls.map((c) => c.name)).not.toContain("record_claimed_ai_decision");
    expect(calls.map((c) => c.name)).not.toContain("renew_proposal_claim");
    expect(result.processed).toBe(0);
    expect(result.attempted).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(first(result.failures).bankTransactionId).toBe("t1");
    // この実行が借りた明細（行は正しく読めた）は返す
    expect(calls.filter((c) => c.name === "release_proposal_claims").map((c) => c.args)).toEqual([{ p_owner: "owner-1", p_ids: ["t1"] }]);
  });

  it("借りた行の amount が不正なら、実行は例外になり、AI も判断の記録もしない（不正な行の返却は主張しない）", async () => {
    const names: string[] = [];
    const client = contextClient(baseRows(), (name) => {
      names.push(name);
      return { data: name === "claim_pending_proposal_batch" ? [claimRow(null)] : null, error: null };
    });
    const ai = vi.fn() as unknown as JournalAi;

    await expect(runProposalJob({ store: supabaseProposalStore(client), ai, today: "2026-11-06" })).rejects.toThrow();

    expect(ai).not.toHaveBeenCalled();
    expect(names).not.toContain("record_claimed_ai_decision");
    // 不正な行の ID はアプリに渡らないので、返却されたとは言えない。SQL 側の貸出しは期限（600 秒）で切れる
  });
});
