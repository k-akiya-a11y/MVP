import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCallResult, JournalAi } from "@/lib/ai/client";
import type { AiJournalOutput } from "@/lib/ai/schema";
import { JOURNAL_MODEL, JOURNAL_PROMPT_VERSION } from "@/lib/ai/version";
import { runProposalJob } from "@/lib/proposals/run";
import { supabaseProposalStore } from "@/lib/proposals/store";
import { partnerKey } from "@/lib/retrieval/normalize";
import { applyShim, createDisposableDatabase, noop, openClient, validateBaseUrl, type DisposableDatabase } from "./disposable-db";

/**
 * 顧客文脈の「最新の読み直し」の DB 結合テスト。期待の記録: docs/reviews/2026-11-06-proposal-context-refresh-db.md（テストより先に書いた）
 *
 * 本物: supabaseProposalStore（zod の検証）、runProposalJob、本物の PostgreSQL 関数 claim_pending_proposal_batch / renew_proposal_claim /
 *       release_proposal_claims / record_claimed_ai_decision（service_role）、本物の表・ビュー（current_*）・制約・追記専用トリガー。
 *       全マイグレーションと seed を適用した、このファイル専用の使い捨て DB。制約は緩めない。
 * 代役: SupabaseClient は、ストアが実際に呼ぶ rpc 4 種と from(...) 6 表の読取だけを許可した、pg の接続（SQL）で答える狭い偽物
 *       （許可は表・select の列・メソッドの並びの完全一致。それ以外は即座に投げる）。値は必ずパラメータ。bigint は ::text で丸めない。
 *       AI は vi.fn（実 SDK・ネットワークなし）。
 * 本物のコミット: 偽物は呼出し 1 回ごとに自分の接続で begin → set local role service_role → 実行 → commit する。
 *       間に入る変更は、別の接続（writer）が begin → commit する。最後に第三の接続（admin）からも見えることを観測する。
 * 順序の固定: 変更は「record_claimed_ai_decision がコミットされた直後・その応答をストアに返す前」に行う（フックを await する）。
 *       sleep・タイマー・競合には頼らない。次の claim と文脈の読込は、その変更のコミットの後に始まる。
 *
 * 保証すること: 変更のコミットが次の loadCustomerContext の開始より前に済んでいれば、その読込は変更を見る。
 * 保証しないこと: 読込の途中・後に入った変更が、判定中の明細に反映されること（読込は原子的なスナップショットではない）。
 *       HTTP・PostgREST（bigint は実際は JSON の数値）・RLS・ブラウザ・実 AI は通らない。同時実行の競合も試さない。
 *
 * 隔離: ai_decisions・ルール版・メモ版は追記専用で消せない。ケースごとに新しい顧客・口座・マスタ・明細を作り、他のケースのデータは消さない。
 */

const DB_PREFIX = "mvp_ctx_refresh_test_";
const TODAY = "2026-11-06";
const UNSAFE = "9007199254740993";
const TEST_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 30_000;
const TXN_DESCRIPTION = "ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ";
const PAST_BANK_DESCRIPTION = "ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ";

const KEY = partnerKey(TXN_DESCRIPTION);
if (KEY === null) throw new Error("the synthetic description has no partner key");

/** ID はケース番号から決める（kind: 1 顧客 / 2 口座 / 3 取込 / 4 明細 / 5 ルール / 6 メモ / 7 過去仕訳 / 8 owner） */
function uid(kind: number, scenario: number, seq = 1): string {
  return `9700000${kind}-0000-4000-8000-${String(scenario).padStart(6, "0")}${String(seq).padStart(6, "0")}`;
}
const OWNER = uid(8, 0, 1); // テスト対象のストアの owner
const OWNER_OTHER = uid(8, 0, 2); // 無関係な別の実行

let disposable: DisposableDatabase | undefined;
let admin: Client; // 所有者のロール・自動コミット。準備と観測だけ
let storeConn: Client; // テスト対象のストアが使う接続
let writerConn: Client; // 間に入る変更をコミットする、別の接続
let storePid = 0;
let writerPid = 0;

beforeAll(async () => {
  const base = validateBaseUrl();
  disposable = await createDisposableDatabase(base, DB_PREFIX);
  try {
    admin = await openClient(disposable.url, "ctx-refresh-admin");
    const current = (await admin.query<{ db: string }>("select current_database() as db")).rows[0]!.db;
    if (current !== disposable.name || !current.startsWith(DB_PREFIX)) throw new Error(`refusing to run: connected to ${current}, not the disposable database`);
    await applyShim(admin, readFileSync(join(process.cwd(), "tests/db/supabase-shim.sql"), "utf8"));
    for (const dir of ["supabase/migrations", "supabase/seed"]) {
      for (const name of readdirSync(join(process.cwd(), dir)).filter((n) => n.endsWith(".sql")).sort()) {
        await admin.query(readFileSync(join(process.cwd(), dir, name), "utf8"));
      }
    }
    storeConn = await openClient(disposable.url, "ctx-refresh-store");
    writerConn = await openClient(disposable.url, "ctx-refresh-writer");
    storePid = (await storeConn.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    writerPid = (await writerConn.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    if (storePid === writerPid) throw new Error("the store and the writer must be separate connections");
  } catch (error) {
    await Promise.all([admin, storeConn, writerConn].map((c) => c?.end().catch(noop)));
    await disposable.drop();
    throw error;
  }
}, 180_000);

afterAll(async () => {
  const errors: unknown[] = [];
  // 自分の接続だけを片付ける。未確定のトランザクションがあれば戻してから閉じる。失敗は握りつぶさず、最後にまとめて投げる
  for (const c of [storeConn, writerConn]) await c?.query("rollback").catch(noop);
  for (const c of [admin, storeConn, writerConn]) {
    try {
      await c?.end();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await disposable?.drop(); // 自分が作った DB だけ
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "cleanup of the proposal-context-refresh test failed");
}, 60_000);

beforeEach(async () => {
  // 前のテストが失敗して未確定のトランザクションを残していても、次のテストに持ち越さない
  for (const c of [storeConn, writerConn]) await c.query("rollback").catch(noop);
});

async function within<T>(promise: Promise<T>, label: string, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 狭い SQL アダプタ（SupabaseClient の偽物。proposal-numeric-boundary.test.ts と同じ形）
// ---------------------------------------------------------------------------

type PgResult = { data: unknown; error: { message: string } | null };

/** 1 本の接続を共有するので、begin〜commit を他の呼出しと混ぜない（Promise.all の読取が同時に来る） */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(noop);
  return run;
}

/** 1 回の SQL を、自分の接続で begin → service_role → 実行 → commit する（本物のコミット）。失敗したらロールバックしてエラーを返す */
async function serviceRows(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; error: { message: string } | null }> {
  return serial(async () => {
    await storeConn.query("begin");
    try {
      await storeConn.query("set local role service_role");
      const res = await storeConn.query<Record<string, unknown>>(sql, params);
      await storeConn.query("commit");
      return { rows: res.rows, error: null };
    } catch (error) {
      await storeConn.query("rollback").catch(noop);
      return { rows: [], error: { message: error instanceof Error ? error.message : String(error) } };
    }
  });
}

function onlyKeys(args: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(args).sort().join(",");
  const expected = [...keys].sort().join(",");
  if (actual !== expected) throw new Error(`rpc arguments are not allowlisted: ${actual} (expected ${expected})`);
}

async function scalar(sql: string, params: unknown[]): Promise<PgResult> {
  const res = await serviceRows(sql, params);
  if (res.error) return { data: null, error: res.error };
  return { data: res.rows[0]?.["v"] ?? null, error: null };
}

/** supabaseProposalStore が呼ぶ rpc だけ。引数のキーも完全一致を要求する */
async function rpc(name: string, args: Record<string, unknown>): Promise<PgResult> {
  switch (name) {
    case "claim_pending_proposal_batch": {
      onlyKeys(args, ["p_limit", "p_owner", "p_lease_seconds"]);
      const res = await serviceRows(
        `select c.id, c.customer_id, c.wallet_id, to_char(c.txn_date, 'YYYY-MM-DD') as txn_date, c.amount::text as amount, c.direction, c.description
         from public.claim_pending_proposal_batch($1::integer, $2::uuid, $3::integer) c`,
        [args["p_limit"], args["p_owner"], args["p_lease_seconds"]],
      );
      return res.error ? { data: null, error: res.error } : { data: res.rows, error: null };
    }
    case "renew_proposal_claim":
      onlyKeys(args, ["p_owner", "p_bank_transaction_id", "p_lease_seconds"]);
      return scalar("select public.renew_proposal_claim($1::uuid, $2::uuid, $3::integer) as v", [args["p_owner"], args["p_bank_transaction_id"], args["p_lease_seconds"]]);
    case "release_proposal_claims":
      onlyKeys(args, ["p_owner", "p_ids"]);
      return scalar("select public.release_proposal_claims($1::uuid, $2::uuid[]) as v", [args["p_owner"], args["p_ids"]]);
    case "record_claimed_ai_decision":
      onlyKeys(args, ["p_owner", "p_decision"]);
      return scalar("select public.record_claimed_ai_decision($1::uuid, $2::jsonb) as v", [args["p_owner"], JSON.stringify(args["p_decision"])]);
    default:
      throw new Error(`rpc is not allowlisted: ${name}`);
  }
}

const PAGE = "limit $%L::integer offset $%O::integer";
function paged(sql: string, limitIndex: number): string {
  return `${sql} ${PAGE.replace("%L", String(limitIndex)).replace("%O", String(limitIndex + 1))}`;
}

/** key は呼出しの並び（select の列・eq / gte / lte / order / range / single）の完全一致。値は呼出し順にパラメータへ並ぶ（range は limit・offset） */
const READS: Record<string, { key: string; sql: string; single?: true }> = {
  customers: {
    key: "select:id, name, tax_method, invoice_registered, low_confidence_amount_threshold|eq:id|single",
    single: true,
    sql: `select c.id, c.name, c.tax_method, c.invoice_registered, c.low_confidence_amount_threshold::text as low_confidence_amount_threshold
          from public.customers c where c.id = $1::uuid`,
  },
  freee_masters: {
    key: "select:kind, freee_id, name, attrs|eq:customer_id|eq:available|order:kind|order:freee_id|range",
    sql: paged(
      `select m.kind, m.freee_id::text as freee_id, m.name, m.attrs
       from public.freee_masters m where m.customer_id = $1::uuid and m.available = $2::boolean order by m.kind, m.freee_id`,
      3,
    ),
  },
  current_journal_rules: {
    key: "select:*|eq:customer_id|order:rule_id|range",
    sql: paged(
      `select r.rule_id, r.version, r.priority, r.status,
              to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"') as created_at,
              r.cond_partner_key, r.cond_description_keyword,
              r.cond_amount_min::text as cond_amount_min, r.cond_amount_max::text as cond_amount_max,
              r.cond_wallet_id, r.cond_direction,
              r.account_item_id::text as account_item_id, r.tax_code, r.partner_id::text as partner_id,
              r.item_id::text as item_id, r.section_id::text as section_id, r.tag_ids::text[] as tag_ids,
              r.description_template,
              to_char(r.valid_from, 'YYYY-MM-DD') as valid_from, to_char(r.valid_to, 'YYYY-MM-DD') as valid_to
       from public.current_journal_rules r where r.customer_id = $1::uuid order by r.rule_id`,
      2,
    ),
  },
  current_customer_notes: {
    key: "select:note_id, version, status, title, body|eq:customer_id|order:note_id|range",
    sql: paged(
      `select n.note_id, n.version, n.status, n.title, n.body
       from public.current_customer_notes n where n.customer_id = $1::uuid order by n.note_id`,
      2,
    ),
  },
  past_journal_entries: {
    key: "select:id, entry_date, amount, direction, bank_description, partner_key, account_item_id, tax_code, partner_id, item_id, section_id, tag_ids, description|eq:customer_id|gte:entry_date|lte:entry_date|order:id|range",
    sql: paged(
      `select p.id, to_char(p.entry_date, 'YYYY-MM-DD') as entry_date, p.amount::text as amount, p.direction, p.bank_description, p.partner_key,
              p.account_item_id::text as account_item_id, p.tax_code, p.partner_id::text as partner_id,
              p.item_id::text as item_id, p.section_id::text as section_id, p.tag_ids::text[] as tag_ids, p.description
       from public.past_journal_entries p
       where p.customer_id = $1::uuid and p.entry_date >= $2::date and p.entry_date <= $3::date order by p.id`,
      4,
    ),
  },
  wallets: {
    key: "select:id, name|eq:customer_id|order:id|range",
    sql: paged("select w.id, w.name from public.wallets w where w.customer_id = $1::uuid order by w.id", 2),
  },
};

/** select(...).eq(...)...range(...) の連鎖を記録し、await されたときに許可された SQL を 1 回実行する */
class ReadBuilder implements PromiseLike<PgResult> {
  private readonly table: string;
  private readonly calls: string[] = [];
  private readonly values: unknown[] = [];

  constructor(table: string) {
    this.table = table;
  }
  select(columns: string): this {
    this.calls.push(`select:${columns}`);
    return this;
  }
  eq(column: string, value: unknown): this {
    this.calls.push(`eq:${column}`);
    this.values.push(value);
    return this;
  }
  gte(column: string, value: unknown): this {
    this.calls.push(`gte:${column}`);
    this.values.push(value);
    return this;
  }
  lte(column: string, value: unknown): this {
    this.calls.push(`lte:${column}`);
    this.values.push(value);
    return this;
  }
  order(column: string, options?: unknown): this {
    this.calls.push(options === undefined ? `order:${column}` : `order:${column}:${JSON.stringify(options)}`);
    return this;
  }
  range(from: number, to: number): this {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) throw new Error(`range is not valid: ${from}-${to}`);
    this.calls.push("range");
    this.values.push(to - from + 1, from);
    return this;
  }
  single(): this {
    this.calls.push("single");
    return this;
  }
  then<A = PgResult, B = never>(
    onfulfilled?: ((value: PgResult) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<PgResult> {
    const spec = READS[this.table];
    const key = this.calls.join("|");
    if (!spec || spec.key !== key) throw new Error(`query is not allowlisted: ${this.table} ${key}`);
    const res = await serviceRows(spec.sql, this.values);
    if (res.error) return { data: null, error: res.error };
    if (spec.single) {
      return res.rows.length === 1 ? { data: res.rows[0], error: null } : { data: null, error: { message: `expected one row, got ${res.rows.length}` } };
    }
    return { data: res.rows, error: null };
  }
}

type Hooks = {
  /** n 件目の record_claimed_ai_decision がコミットされた直後、その応答をストアに返す前に走る（n は 1 から） */
  afterRecord?: (recorded: number) => Promise<void>;
};

function fakeSupabase(hooks: Hooks = {}): { supabase: SupabaseClient; rpcNames: string[]; fromNames: string[]; hookErrors: unknown[] } {
  const rpcNames: string[] = [];
  const fromNames: string[] = [];
  const hookErrors: unknown[] = [];
  let recorded = 0;
  const fake = {
    rpc: async (name: string, args: Record<string, unknown>): Promise<PgResult> => {
      rpcNames.push(name);
      const result = await rpc(name, args);
      if (name === "record_claimed_ai_decision" && !result.error) {
        recorded++;
        try {
          await hooks.afterRecord?.(recorded);
        } catch (error) {
          hookErrors.push(error); // ストアの失敗に紛れさせない。テストが最初に確認する
          throw error;
        }
      }
      return result;
    },
    from: (table: string) => {
      fromNames.push(table);
      return { select: (columns: string) => new ReadBuilder(table).select(columns) };
    },
  };
  return { supabase: fake as unknown as SupabaseClient, rpcNames, fromNames, hookErrors };
}

/**
 * 別の接続（writer）で begin → 変更 → commit する。その時点でストアの接続に未確定のトランザクションがなく（idle）、
 * writer が別のバックエンドであることを確認する（同じトランザクションの中の変更ではない）。
 */
async function commitOnWriter(change: (writer: Client) => Promise<void>): Promise<void> {
  expect(writerPid).not.toBe(storePid);
  const state = await admin.query<{ state: string | null }>("select state from pg_stat_activity where pid = $1", [storePid]);
  expect(state.rows[0]?.state).toBe("idle");
  await writerConn.query("begin");
  try {
    await change(writerConn);
    await writerConn.query("commit");
  } catch (error) {
    await writerConn.query("rollback").catch(noop);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// データの準備と観測
// ---------------------------------------------------------------------------

const aiOutput: AiJournalOutput = {
  decision: "proposal",
  account_item_id: 105,
  tax_code: 21,
  partner_id: 302,
  item_id: null,
  section_id: 401,
  tag_ids: [],
  description: "家賃",
  reason: "過去の仕訳と同じ",
  unknowns: [],
  fixed_asset_possible: false,
  officer_or_personal: false,
};
const usage = { inputTokens: 3000, outputTokens: 300, cacheReadTokens: 2500, cacheWriteTokens: 0, costUsdMicros: 9500 };
const mockAi = () =>
  vi.fn(async () => ({ status: "ok", output: aiOutput, model: JOURNAL_MODEL, promptVersion: JOURNAL_PROMPT_VERSION, usage }) as AiCallResult) as JournalAi &
    ReturnType<typeof vi.fn>;

type PromptData = {
  notes: Array<{ title: string; body: string }>;
  past: { total: number; examples: Array<{ entry: { description: string } }> };
};

/** n 回目の AI 呼出しに実際に渡った入力（user メッセージの JSON） */
function promptData(ai: ReturnType<typeof vi.fn>, index: number): PromptData {
  const prompt = ai.mock.calls[index]?.[0] as { messages?: Array<{ content?: unknown }> } | undefined;
  const content = prompt?.messages?.[0]?.content;
  if (typeof content !== "string") throw new Error(`AI call ${index} has no string prompt`);
  return JSON.parse(content) as PromptData;
}

type Fixture = { customer: string; txns: string[] };

const MASTERS: Array<[string, number, string, string]> = [
  ["account_item", 101, "通信費", '{"default_tax_code": 21}'],
  ["account_item", 102, "消耗品費", '{"default_tax_code": 21}'],
  ["account_item", 105, "地代家賃", '{"default_tax_code": 21}'],
  ["tax", 21, "課対仕入10%", "{}"],
  ["partner", 302, "サンプル不動産株式会社", '{"kana": "ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ"}'],
  ["section", 401, "本社", "{}"],
];

/**
 * このケースだけの顧客・口座・マスタ・取込・未判定の明細を作る。前のケースが残した new の明細は保留に退避し（記録は触らない）、
 * 貸出しを空にし、走査位置を先頭に戻す。ai_decisions・ルール版・メモ版は追記専用なので、消さない。
 */
async function createFixture(scenario: number, txnCount: number): Promise<Fixture> {
  const customer = uid(1, scenario);
  const wallet = uid(2, scenario);
  const importId = uid(3, scenario);
  const txns = Array.from({ length: txnCount }, (_, i) => uid(4, scenario, i + 1));
  await admin.query("begin");
  try {
    await admin.query("update public.bank_transactions set status = 'on_hold' where status = 'new'");
    await admin.query("delete from public.proposal_leases");
    await admin.query("update public.proposal_scan_cursor set last_txn_date = null, last_id = null");
    await admin.query(
      `insert into public.customers (id, name, fiscal_year_end_month, tax_method, invoice_registered)
       values ($1, $2, 3, 'general', true)`,
      [customer, `文脈確認用の合成商事 ${scenario}`],
    );
    await admin.query(
      `insert into public.wallets (id, customer_id, kind, name, freee_walletable_id) values ($1, $2, 'bank_account', $3, $4)`,
      [wallet, customer, `合成銀行 ${scenario}`, 9000 + scenario],
    );
    for (const [kind, freeeId, name, attrs] of MASTERS) {
      await admin.query(
        "insert into public.freee_masters (customer_id, kind, freee_id, name, attrs) values ($1, $2, $3, $4, $5::jsonb)",
        [customer, kind, freeeId, name, attrs],
      );
    }
    await admin.query(
      `insert into public.statement_imports (id, customer_id, wallet_id, source, row_count, inserted_count)
       values ($1, $2, $3, 'csv', $4, $4)`,
      [importId, customer, wallet, txnCount],
    );
    for (const [i, id] of txns.entries()) {
      await admin.query(
        `insert into public.bank_transactions (id, customer_id, wallet_id, import_id, txn_date, amount, direction, description, dedupe_key)
         values ($1, $2, $3, $4, $5, 12000, 'expense', $6, $7)`,
        [id, customer, wallet, importId, `2026-10-${28 + i}`, TXN_DESCRIPTION, `ctx-refresh-${scenario}-${i + 1}`],
      );
    }
    await admin.query("commit");
  } catch (error) {
    await admin.query("rollback").catch(noop);
    throw error;
  }
  return { customer, txns };
}

const RULE_VERSION_SQL = `insert into public.journal_rule_versions
  (rule_id, version, customer_id, priority, status, source, cond_partner_key, cond_direction, account_item_id, tax_code, partner_id, section_id, description_template)
  values ($1, $2, $3, 10, $4, 'staff', $5, 'expense', $6, 21, 302, 401, $7)`;
const NOTE_VERSION_SQL = `insert into public.customer_note_versions (note_id, version, customer_id, status, title, body)
  values ($1, $2, $3, $4, $5, $6)`;
const PAST_SQL = `insert into public.past_journal_entries
  (id, customer_id, source, freee_source_id, entry_date, amount, direction, bank_description, partner_key, partner_id, account_item_id, tax_code, section_id, tag_ids, description)
  values ($1, $2, 'freee_deal', $3, $4, 12000, 'expense', $5, $6, 302, 105, 21, 401, '{}', $7)`;

type DecisionRow = {
  bank_transaction_id: string;
  rule_versions_used: unknown;
  note_versions_used: unknown;
  past_entry_ids: string[];
  proposal: Record<string, unknown> | null;
  has_ai_output: boolean;
  model: string | null;
};

/** 顧客の AI 判断を、明細の日付順に（第三の接続 admin から。コミット済みのものだけが見える） */
async function decisions(customer: string): Promise<DecisionRow[]> {
  const res = await admin.query<DecisionRow>(
    `select d.bank_transaction_id, d.rule_versions_used, d.note_versions_used, d.past_entry_ids::text[] as past_entry_ids, d.proposal,
            (d.ai_output is not null) as has_ai_output, d.model
     from public.ai_decisions d
     join public.bank_transactions b on b.id = d.bank_transaction_id and b.customer_id = d.customer_id
     where d.customer_id = $1 order by b.txn_date, b.id`,
    [customer],
  );
  return res.rows;
}

async function statuses(ids: string[]): Promise<Array<{ id: string; status: string }>> {
  return (await admin.query<{ id: string; status: string }>("select id, status from public.bank_transactions where id = any($1::uuid[]) order by txn_date, id", [ids])).rows;
}

type LeaseRow = { bank_transaction_id: string; owner: string; lease_expires_at: string };

async function leases(ids: string[]): Promise<LeaseRow[]> {
  return (
    await admin.query<LeaseRow>(
      `select bank_transaction_id, owner, lease_expires_at::text as lease_expires_at
       from public.proposal_leases where bank_transaction_id = any($1::uuid[]) order by bank_transaction_id`,
      [ids],
    )
  ).rows;
}

/** runProposalJob を本物のストア・本物の DB で実行する。batchSize は明細数 + 1（最後の claim が空で終わる実行にする） */
async function runJob(txnCount: number, ai: JournalAi, hooks: Hooks) {
  const fake = fakeSupabase(hooks);
  const result = await within(
    runProposalJob({ store: supabaseProposalStore(fake.supabase, OWNER), ai, today: TODAY }, txnCount + 1),
    "runProposalJob",
    RUN_TIMEOUT_MS,
  );
  expect(fake.hookErrors).toEqual([]);
  return { result, rpcNames: fake.rpcNames, fromNames: fake.fromNames };
}

const CLAIM = "claim_pending_proposal_batch";
const RENEW = "renew_proposal_claim";
const RECORD = "record_claimed_ai_decision";
const RELEASE = "release_proposal_claims";

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe("別の接続がコミットした変更は、次の明細の文脈の読込で本物の SQL から見える", () => {
  it(
    "ルール: 1 件目の記録後に新しい版、2 件目の記録後に無効の版をコミット → 各明細はその時点の最新版で決まり、3 件目は AI に回る。版の履歴は残る",
    async () => {
      const f = await createFixture(1, 3);
      const [t1, t2, t3] = f.txns as [string, string, string];
      const rule = uid(5, 1);
      await admin.query("insert into public.journal_rules (id, customer_id) values ($1, $2)", [rule, f.customer]);
      await admin.query(RULE_VERSION_SQL, [rule, 1, f.customer, "active", KEY, 102, "{month}月分 旧ルール"]);
      const ai = mockAi();

      const { result, rpcNames } = await runJob(3, ai, {
        afterRecord: async (n) => {
          if (n === 1) await commitOnWriter(async (w) => void (await w.query(RULE_VERSION_SQL, [rule, 2, f.customer, "active", KEY, 105, "{month}月分 新ルール"])));
          if (n === 2) await commitOnWriter(async (w) => void (await w.query(RULE_VERSION_SQL, [rule, 3, f.customer, "inactive", KEY, 105, "{month}月分 無効化"])));
        },
      });

      expect(result).toMatchObject({ processed: 3, attempted: 3, truncated: false, failures: [] });
      expect(rpcNames).toEqual([CLAIM, RENEW, RECORD, CLAIM, RENEW, RECORD, CLAIM, RENEW, RECORD, CLAIM]);
      expect(ai).toHaveBeenCalledTimes(1); // 3 件目だけ（版 3 が無効でルールが一致しない）

      const rows = await decisions(f.customer);
      expect(rows.map((r) => r.bank_transaction_id)).toEqual([t1, t2, t3]);
      expect(rows[0]).toMatchObject({
        rule_versions_used: [{ rule_id: rule, version: 1 }],
        proposal: { account_item_id: 102, description: "10月分 旧ルール" },
        has_ai_output: false,
        model: null,
      });
      expect(rows[1]).toMatchObject({
        rule_versions_used: [{ rule_id: rule, version: 2 }],
        proposal: { account_item_id: 105, description: "10月分 新ルール" },
        has_ai_output: false,
        model: null,
      });
      expect(rows[2]).toMatchObject({ rule_versions_used: [], has_ai_output: true, model: JOURNAL_MODEL });

      // 履歴は追記のみ。版 1 は書き換わっていない
      const versions = await admin.query<{ version: number; status: string; account_item_id: string }>(
        "select version, status, account_item_id::text as account_item_id from public.journal_rule_versions where rule_id = $1 order by version",
        [rule],
      );
      expect(versions.rows).toEqual([
        { version: 1, status: "active", account_item_id: "102" },
        { version: 2, status: "active", account_item_id: "105" },
        { version: 3, status: "inactive", account_item_id: "105" },
      ]);
      expect(await leases(f.txns)).toEqual([]);
      expect((await statuses(f.txns)).map((s) => s.status)).toEqual(["proposed", "proposed", "proposed"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "メモ: 1 件目の記録後に新しい版、2 件目の記録後に無効の版をコミット → AI の入力と note_versions_used が各明細の時点の最新版になる",
    async () => {
      const f = await createFixture(2, 3);
      const note = uid(6, 2);
      await admin.query("insert into public.customer_notes (id, customer_id) values ($1, $2)", [note, f.customer]);
      await admin.query(NOTE_VERSION_SQL, [note, 1, f.customer, "active", "旧メモの題名", "旧メモの本文"]);
      const ai = mockAi();

      const { result } = await runJob(3, ai, {
        afterRecord: async (n) => {
          if (n === 1) await commitOnWriter(async (w) => void (await w.query(NOTE_VERSION_SQL, [note, 2, f.customer, "active", "新メモの題名", "新メモの本文"])));
          if (n === 2) await commitOnWriter(async (w) => void (await w.query(NOTE_VERSION_SQL, [note, 3, f.customer, "inactive", "無効メモの題名", "無効メモの本文"])));
        },
      });

      expect(result).toMatchObject({ processed: 3, attempted: 3, truncated: false, failures: [] });
      expect(ai).toHaveBeenCalledTimes(3);
      expect(promptData(ai, 0).notes).toEqual([{ title: "旧メモの題名", body: "旧メモの本文" }]);
      expect(promptData(ai, 1).notes).toEqual([{ title: "新メモの題名", body: "新メモの本文" }]); // 版 1 は含まない
      expect(promptData(ai, 2).notes).toEqual([]); // 無効の版 3 が最新

      const rows = await decisions(f.customer);
      expect(rows.map((r) => r.note_versions_used)).toEqual([[{ note_id: note, version: 1 }], [{ note_id: note, version: 2 }], []]);

      const versions = await admin.query<{ version: number; status: string; title: string }>(
        "select version, status, title from public.customer_note_versions where note_id = $1 order by version",
        [note],
      );
      expect(versions.rows).toEqual([
        { version: 1, status: "active", title: "旧メモの題名" },
        { version: 2, status: "active", title: "新メモの題名" },
        { version: 3, status: "inactive", title: "無効メモの題名" },
      ]);
      expect(await leases(f.txns)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "過去仕訳: 1 件目の記録後に同じ取引先の過去仕訳を追加コミット → 2 件目の AI の入力と past_entry_ids に追加分が入る。元の仕訳は変わらない",
    async () => {
      const f = await createFixture(3, 2);
      const [p1, p2] = [uid(7, 3, 1), uid(7, 3, 2)];
      await admin.query(PAST_SQL, [p1, f.customer, 1, "2026-09-28", PAST_BANK_DESCRIPTION, KEY, "前期の家賃"]);
      const ai = mockAi();

      const { result } = await runJob(2, ai, {
        afterRecord: async (n) => {
          if (n === 1) await commitOnWriter(async (w) => void (await w.query(PAST_SQL, [p2, f.customer, 2, "2026-10-27", PAST_BANK_DESCRIPTION, KEY, "追加された家賃"])));
        },
      });

      expect(result).toMatchObject({ processed: 2, attempted: 2, truncated: false, failures: [] });
      expect(ai).toHaveBeenCalledTimes(2);
      const first = promptData(ai, 0).past;
      const second = promptData(ai, 1).past;
      expect(first.total).toBe(1);
      expect(first.examples.map((e) => e.entry.description)).toEqual(["前期の家賃"]);
      expect(second.total).toBe(2);
      expect(second.examples.map((e) => e.entry.description).sort()).toEqual(["前期の家賃", "追加された家賃"].sort());

      const rows = await decisions(f.customer);
      expect(rows.map((r) => [...r.past_entry_ids].sort())).toEqual([[p1], [p1, p2].sort()]);

      const past = await admin.query<{ id: string; amount: string; description: string }>(
        "select id, amount::text as amount, description from public.past_journal_entries where customer_id = $1 order by id",
        [f.customer],
      );
      expect(past.rows).toEqual([
        { id: p1, amount: "12000", description: "前期の家賃" },
        { id: p2, amount: "12000", description: "追加された家賃" },
      ]);
      expect(await leases(f.txns)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("2 件目の文脈の読込が失敗したとき、古い文脈に退避しない", () => {
  it(
    "コミットされた安全でない閾値 9007199254740993: 本物のストアの検証器が 2 件目を失敗にし、2 回目の AI も判断の記録もない。貸出しは返し、無関係な別の owner の貸出しは変わらない",
    async () => {
      const f = await createFixture(4, 3);
      const [t1, t2, t3] = f.txns as [string, string, string];
      await admin.query("insert into public.proposal_leases (bank_transaction_id, owner, lease_expires_at) values ($1, $2, now() + interval '1 hour')", [t3, OWNER_OTHER]);
      const unrelated = await leases([t3]);
      expect(unrelated).toMatchObject([{ bank_transaction_id: t3, owner: OWNER_OTHER }]);
      const ai = mockAi();

      const { result, rpcNames, fromNames } = await runJob(3, ai, {
        afterRecord: async (n) => {
          if (n === 1) {
            await commitOnWriter(async (w) => void (await w.query("update public.customers set low_confidence_amount_threshold = $2 where id = $1", [f.customer, UNSAFE])));
          }
        },
      });

      // 変更は実際にコミットされ、第三の接続から見える（DB の bigint はこの値を持つ。制約は緩めていない）
      const stored = await admin.query<{ v: string }>("select low_confidence_amount_threshold::text as v from public.customers where id = $1", [f.customer]);
      expect(stored.rows.map((r) => r.v)).toEqual([UNSAFE]);

      expect(result).toMatchObject({ processed: 1, attempted: 2, truncated: false });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({ bankTransactionId: t2 });
      expect(result.failures[0]!.error).toContain("low_confidence_amount_threshold");
      expect(ai).toHaveBeenCalledTimes(1); // 1 件目だけ。2 件目に古い文脈で 2 回目を呼ばない
      // 2 件目の claim の後、3 件目は別の owner が借りているので、次の claim は空。最後に失敗した 2 件目だけを返す
      expect(rpcNames).toEqual([CLAIM, RENEW, RECORD, CLAIM, CLAIM, RELEASE]);
      expect(fromNames.filter((n) => n === "customers")).toHaveLength(2); // 1 件目の読込と、失敗した 2 件目の読込

      const rows = await decisions(f.customer);
      expect(rows.map((r) => r.bank_transaction_id)).toEqual([t1]);
      expect((await statuses(f.txns)).map((s) => s.status)).toEqual(["proposed", "new", "new"]);
      // 2 件目の貸出しは返却済み。別の owner の貸出しは、期限も含めて変わらない
      expect(await leases(f.txns)).toEqual(unrelated);
    },
    TEST_TIMEOUT_MS,
  );
});
