import type { SupabaseClient } from "@supabase/supabase-js";
import { vi } from "vitest";
import { CID, fakeClient, fail, masterRows, ok, page, USER, type Call, type Reply } from "./rule-editor";

/** 候補からのルール作成のテスト用の合成データ（架空のデータだけ。実 DB・実サービスには接続しない） */
export const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
export const KEY = "ACME";

export const entry = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  customer_id: CID,
  entry_date: "2026-01-05",
  direction: "expense",
  partner_key: KEY,
  account_item_id: 100,
  ...o,
});

/** ACME・出金は科目100だけ（候補になる） */
export const stableEntries = () => [entry("p1"), entry("p2", { entry_date: "2026-02-05" })];

/** 税区分 0 を含むマスタ（税区分 0 が本物の選択肢である場合） */
export const mastersWithTaxZero = (customerId = CID) => [
  ...masterRows(customerId),
  { customer_id: customerId, kind: "tax", freee_id: 0, name: "対象外", available: true },
];

type Scenario = {
  customer?: unknown;
  entries?: unknown[];
  masters?: unknown[];
};

/** eq(列, 値) の条件を行に適用する（実際の絞り込みの代役） */
function applyEq(rows: unknown[], c: Call): unknown[] {
  let out = rows as Record<string, unknown>[];
  for (const o of c.ops.filter((x) => x.op === "eq")) {
    const [col, value] = o.args as [string, unknown];
    out = out.filter((r) => r[col] === value);
  }
  return out;
}

export function candidateScenario(s: Scenario = {}) {
  return (c: Call): Reply => {
    switch (c.table) {
      case "customers":
        return ok(s.customer === undefined ? { id: CID, name: "テスト商事" } : s.customer);
      case "past_journal_entries":
        return page(s.entries ?? stableEntries(), c);
      case "freee_masters":
        return page(applyEq(s.masters ?? masterRows(), c), c);
      default:
        return fail(`unexpected table ${c.table}`);
    }
  };
}

export type RpcCall = { fn: string; args: Record<string, unknown> };

/** 読込用の fakeClient に rpc を足したクライアント。rpc の呼出しと、テーブルへの書込を記録する */
export function rpcClient(
  scenario: ReturnType<typeof candidateScenario>,
  rpc: (call: RpcCall) => Reply | Promise<Reply> = (c) => ok(c.args.p_rule_id),
  opts: { user?: { id: string } | null; getUserThrows?: boolean } = {},
) {
  const base = fakeClient(scenario, opts);
  const rpcCalls: RpcCall[] = [];
  const rpcMock = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    const call = { fn, args };
    rpcCalls.push(call);
    return rpc(call);
  });
  const client = { ...(base.client as unknown as Record<string, unknown>), rpc: rpcMock } as unknown as SupabaseClient;
  return { client, calls: base.calls, rpcCalls, rpcMock, getUser: base.getUser };
}

export const writes = (calls: Call[]) =>
  calls.filter((c) => c.ops.some((o) => ["insert", "update", "delete", "upsert"].includes(o.op)));

/** 保存の入力。上書きしたい項目だけ渡す */
export const validCreateInput = (o: Record<string, unknown> = {}) => ({
  customerId: CID,
  requestId: REQUEST_ID,
  partnerKey: KEY,
  direction: "expense",
  accountItemId: 100,
  taxCode: 10,
  priority: 100,
  ...o,
});

export { USER };
