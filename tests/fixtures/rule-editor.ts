import type { SupabaseClient } from "@supabase/supabase-js";
import { vi } from "vitest";

/** ルール編集のテスト用の合成データと、Supabase クライアントの代役（架空のデータだけ。実 DB・実サービスには接続しない） */
export const CID = "11111111-1111-4111-8111-111111111111";
export const OTHER_CID = "99999999-9999-4999-8999-999999999999";
export const RID = "22222222-2222-4222-8222-222222222222";
export const WID = "33333333-3333-4333-8333-333333333333";
export const USER = "44444444-4444-4444-8444-444444444444";
export const SECRET = "sk-secret-INFRA-token rls policy journal_rule_versions";

export type Op = { op: string; args: unknown[] };
export type Call = { table: string; ops: Op[] };
export type Reply = { data: unknown; error: { message: string; code?: string } | null };

export const ok = (data: unknown): Reply => ({ data, error: null });
export const fail = (message: string, code?: string): Reply => ({ data: null, error: { message, ...(code !== undefined ? { code } : {}) } });

export const has = (c: Call, op: string) => c.ops.some((o) => o.op === op);
export const arg = (c: Call, op: string, index = 0) => c.ops.find((o) => o.op === op)?.args[index];
export const eqs = (c: Call) => c.ops.filter((o) => o.op === "eq").map((o) => `${String(o.args[0])}=${String(o.args[1])}`);

/** range 付きの問合せには、その範囲の行だけを返す（ページ分割の確認用） */
export function page(rows: unknown[], c: Call): Reply {
  const range = c.ops.find((o) => o.op === "range");
  if (!range) return ok(rows);
  const [from, to] = range.args as [number, number];
  return ok(rows.slice(from, to + 1));
}

export function fakeClient(handler: (c: Call) => Reply | Promise<Reply>, opts: { user?: { id: string } | null; getUserThrows?: boolean } = {}) {
  const calls: Call[] = [];
  const getUser = vi.fn(async () => {
    if (opts.getUserThrows) throw new Error(SECRET);
    return { data: { user: opts.user === undefined ? { id: USER } : opts.user }, error: null };
  });
  const client = {
    auth: { getUser },
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const builder: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "gte", "order", "range", "limit", "insert", "update", "delete", "upsert"]) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push({ op, args });
          return builder;
        };
      }
      for (const op of ["maybeSingle", "single"]) {
        builder[op] = () => {
          call.ops.push({ op, args: [] });
          return Promise.resolve().then(() => handler(call));
        };
      }
      builder.then = (resolve: (v: Reply) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => handler(call))
          .then(resolve, reject);
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls, getUser };
}

export const versionRow = (o: Record<string, unknown> = {}) => ({
  rule_id: RID,
  version: 3,
  customer_id: CID,
  priority: 100,
  status: "proposed",
  source: "past_entries",
  cond_partner_key: "ACME",
  cond_description_keyword: null,
  cond_amount_min: 1000,
  cond_amount_max: 50000,
  cond_wallet_id: null,
  cond_direction: "expense",
  account_item_id: 100,
  tax_code: 10,
  partner_id: null,
  item_id: null,
  section_id: null,
  tag_ids: [],
  description_template: null,
  valid_from: null,
  valid_to: null,
  created_by: USER,
  created_at: "2026-10-01T00:00:00+00:00",
  ...o,
});

export const masterRows = (customerId = CID) => [
  { customer_id: customerId, kind: "account_item", freee_id: 100, name: "消耗品費", available: true },
  { customer_id: customerId, kind: "account_item", freee_id: 200, name: "通信費", available: true },
  { customer_id: customerId, kind: "tax", freee_id: 10, name: "課税仕入10%", available: true },
  { customer_id: customerId, kind: "partner", freee_id: 7, name: "架空商事", available: true },
  { customer_id: customerId, kind: "tag", freee_id: 5, name: "タグA", available: true },
];

export const walletRows = (customerId = CID) => [{ id: WID, customer_id: customerId, name: "普通預金", kind: "bank_account" }];

type Scenario = {
  customer?: unknown;
  parent?: unknown;
  versions?: unknown[];
  wallets?: unknown[];
  masters?: unknown[];
  insert?: (call: Call) => Reply | Promise<Reply>;
};

/** 保存処理が読む表（顧客・親ルール・版・口座・マスタ）と、版の INSERT への応答を返す標準の応答 */
export function ruleScenario(s: Scenario = {}) {
  return (c: Call): Reply | Promise<Reply> => {
    switch (c.table) {
      case "customers":
        return ok(s.customer === undefined ? { id: CID, name: "テスト商事" } : s.customer);
      case "journal_rules":
        return ok(s.parent === undefined ? { id: RID, customer_id: CID } : s.parent);
      case "journal_rule_versions":
        if (has(c, "insert")) {
          if (s.insert) return s.insert(c);
          const row = arg(c, "insert") as Record<string, unknown>;
          return ok({ ...versionRow(), ...row, created_at: "2026-10-24T00:00:00+00:00" });
        }
        return ok(s.versions ?? [versionRow()]);
      case "wallets":
        return page(s.wallets ?? walletRows(), c);
      case "freee_masters":
        return page(s.masters ?? masterRows(), c);
      default:
        return fail(`unexpected table ${c.table}`);
    }
  };
}

/** 保存の入力（編集元は版3）。上書きしたい項目だけ渡す */
export const validInput = (o: Record<string, unknown> = {}) => ({
  customerId: CID,
  ruleId: RID,
  expectedVersion: 3,
  status: "active",
  priority: 100,
  cond: { partnerKey: "ACME", descriptionKeyword: null, amountMin: 1000, amountMax: 50000, walletId: null, direction: "expense" },
  action: { accountItemId: 100, taxCode: 10, partnerId: null, itemId: null, sectionId: null, tagIds: [], descriptionTemplate: null },
  validFrom: null,
  validTo: null,
  ...o,
});
