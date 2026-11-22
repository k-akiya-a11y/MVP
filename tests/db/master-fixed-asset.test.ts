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
import { applyShim, createDisposableDatabase, noop, openClient, validateBaseUrl, type DisposableDatabase } from "./disposable-db";

/**
 * マスタの attrs.fixed_asset の DB 結合テスト。期待の記録: docs/reviews/2026-11-06-master-fixed-asset-db.md（テストより先に書いた）
 *
 * 本物: supabaseProposalStore（zod の検証）、runProposalJob、本物の PostgreSQL 関数 claim_pending_proposal_batch / renew_proposal_claim /
 *       release_proposal_claims / record_claimed_ai_decision（service_role）、本物の表（freee_masters.attrs は jsonb not null）・追記専用トリガー。
 *       全マイグレーションと seed を適用した、このファイル専用の使い捨て DB。制約は緩めない・alter しない。
 * 代役: SupabaseClient は、ストアが実際に呼ぶ rpc 4 種と from(...) 6 表の読取だけを許可した pg の狭い偽物（proposal-context-refresh.test.ts と同じ形。
 *       許可は表・select の列・メソッドの並びの完全一致。値は必ずパラメータ）。AI は vi.fn（実 SDK・ネットワークなし）。
 * 本物のコミット: 偽物は呼出し 1 回ごとに自分の接続で begin → set local role service_role → 実行 → commit する。観測は別の接続（admin）から行う。
 *
 * 保証しないこと: HTTP・PostgREST・RLS・ブラウザ・実 AI、同時実行、attrs の値の網羅（代表値だけ）。
 * 隔離: ai_decisions は追記専用で消せない。ケースごとに新しい顧客・口座・マスタ・明細を作り、他のケースのデータは消さない（更新・削除も試みない）。
 */

const DB_PREFIX = "mvp_fixed_asset_test_";
const TODAY = "2026-11-06";
const TEST_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 30_000;
const TXN_DESCRIPTION = "ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ";
const FIXED_ASSET_REASON = "固定資産になり得る";

/** ID はケース番号から決める（kind: 1 顧客 / 2 口座 / 3 取込 / 4 明細 / 8 owner） */
function uid(kind: number, scenario: number, seq = 1): string {
  return `9800000${kind}-0000-4000-8000-${String(scenario).padStart(6, "0")}${String(seq).padStart(6, "0")}`;
}
const OWNER = uid(8, 0, 1); // テスト対象のストアの owner
const OWNER_OTHER = uid(8, 0, 2); // 無関係な別の実行

let disposable: DisposableDatabase | undefined;
let admin: Client; // 所有者のロール・自動コミット。準備と観測だけ
let storeConn: Client; // テスト対象のストアが使う接続

beforeAll(async () => {
  const base = validateBaseUrl();
  disposable = await createDisposableDatabase(base, DB_PREFIX);
  try {
    admin = await openClient(disposable.url, "fixed-asset-admin");
    const current = (await admin.query<{ db: string }>("select current_database() as db")).rows[0]!.db;
    if (current !== disposable.name || !current.startsWith(DB_PREFIX)) throw new Error(`refusing to run: connected to ${current}, not the disposable database`);
    await applyShim(admin, readFileSync(join(process.cwd(), "tests/db/supabase-shim.sql"), "utf8"));
    for (const dir of ["supabase/migrations", "supabase/seed"]) {
      for (const name of readdirSync(join(process.cwd(), dir)).filter((n) => n.endsWith(".sql")).sort()) {
        await admin.query(readFileSync(join(process.cwd(), dir, name), "utf8"));
      }
    }
    storeConn = await openClient(disposable.url, "fixed-asset-store");
  } catch (error) {
    await Promise.all([admin, storeConn].map((c) => c?.end().catch(noop)));
    await disposable.drop();
    throw error;
  }
}, 180_000);

afterAll(async () => {
  const errors: unknown[] = [];
  // 自分の接続だけを片付ける。未確定のトランザクションがあれば戻してから閉じる。失敗は握りつぶさず、最後にまとめて投げる
  await storeConn?.query("rollback").catch(noop);
  for (const c of [admin, storeConn]) {
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
  if (errors.length > 0) throw new AggregateError(errors, "cleanup of the master-fixed-asset test failed");
}, 60_000);

beforeEach(async () => {
  // 前のテストが失敗して未確定のトランザクションを残していても、次のテストに持ち越さない
  await storeConn.query("rollback").catch(noop);
  await admin.query("rollback").catch(noop);
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
// 狭い SQL アダプタ（SupabaseClient の偽物。proposal-context-refresh.test.ts と同じ形）
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

function fakeSupabase(): { supabase: SupabaseClient; rpcNames: string[] } {
  const rpcNames: string[] = [];
  const fake = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcNames.push(name);
      return rpc(name, args);
    },
    from: (table: string) => ({ select: (columns: string) => new ReadBuilder(table).select(columns) }),
  };
  return { supabase: fake as unknown as SupabaseClient, rpcNames };
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
  fixed_asset_possible: false, // 強制「低」の原因を、マスタの印だけにする
  officer_or_personal: false,
};
const usage = { inputTokens: 3000, outputTokens: 300, cacheReadTokens: 2500, cacheWriteTokens: 0, costUsdMicros: 9500 };
const mockAi = () =>
  vi.fn(async () => ({ status: "ok", output: aiOutput, model: JOURNAL_MODEL, promptVersion: JOURNAL_PROMPT_VERSION, usage }) as AiCallResult) as JournalAi &
    ReturnType<typeof vi.fn>;

/** 無関係な属性。fixed_asset の検証が、ほかのキーを巻き込まないこと・書き換えないことの観測に使う */
const UNRELATED_ATTRS = { default_tax_code: 21, note: "無関係な属性" };

/** attrs の JSON 文字列を作る。fixed_asset が undefined なら、そのキーを持たせない */
function attrsJson(fixedAsset: unknown): string {
  return JSON.stringify(fixedAsset === undefined ? UNRELATED_ATTRS : { ...UNRELATED_ATTRS, fixed_asset: fixedAsset });
}

const OTHER_MASTERS: Array<[string, number, string, string]> = [
  ["account_item", 101, "通信費", '{"default_tax_code": 21}'],
  ["tax", 21, "課対仕入10%", "{}"],
  ["partner", 302, "サンプル不動産株式会社", '{"kana": "ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ"}'],
  ["section", 401, "本社", "{}"],
];

type Fixture = { customer: string; txns: string[] };

/**
 * このケースだけの顧客・口座・マスタ・取込・未判定の明細を作り、コミットする。勘定科目 105 の attrs は account105Attrs（JSON 文字列）。
 * 前のケースが残した new の明細は保留に退避し（記録は触らない）、貸出しを空にし、走査位置を先頭に戻す。
 */
async function createFixture(scenario: number, txnCount: number, account105Attrs: string): Promise<Fixture> {
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
      [customer, `固定資産の印の確認用の合成商事 ${scenario}`],
    );
    await admin.query(
      `insert into public.wallets (id, customer_id, kind, name, freee_walletable_id) values ($1, $2, 'bank_account', $3, $4)`,
      [wallet, customer, `合成銀行 ${scenario}`, 9000 + scenario],
    );
    for (const [kind, freeeId, name, attrs] of OTHER_MASTERS) {
      await admin.query("insert into public.freee_masters (customer_id, kind, freee_id, name, attrs) values ($1, $2, $3, $4, $5::jsonb)", [
        customer,
        kind,
        freeeId,
        name,
        attrs,
      ]);
    }
    await admin.query("insert into public.freee_masters (customer_id, kind, freee_id, name, attrs) values ($1, 'account_item', 105, '地代家賃', $2::jsonb)", [
      customer,
      account105Attrs,
    ]);
    await admin.query(
      `insert into public.statement_imports (id, customer_id, wallet_id, source, row_count, inserted_count)
       values ($1, $2, $3, 'csv', $4, $4)`,
      [importId, customer, wallet, txnCount],
    );
    for (const [i, id] of txns.entries()) {
      await admin.query(
        `insert into public.bank_transactions (id, customer_id, wallet_id, import_id, txn_date, amount, direction, description, dedupe_key)
         values ($1, $2, $3, $4, $5, 12000, 'expense', $6, $7)`,
        [id, customer, wallet, importId, `2026-10-${28 + i}`, TXN_DESCRIPTION, `fixed-asset-${scenario}-${i + 1}`],
      );
    }
    await admin.query("commit");
  } catch (error) {
    await admin.query("rollback").catch(noop);
    throw error;
  }
  return { customer, txns };
}

type MasterRow = { attrs: unknown; fixed_asset_type: string | null };

/** 管理接続から見える、コミット済みの勘定科目 105 の attrs と fixed_asset の JSON 型（キーがなければ null） */
async function account105(customer: string): Promise<MasterRow[]> {
  return (
    await admin.query<MasterRow>(
      `select attrs, jsonb_typeof(attrs -> 'fixed_asset') as fixed_asset_type
       from public.freee_masters where customer_id = $1 and kind = 'account_item' and freee_id = 105`,
      [customer],
    )
  ).rows;
}

type DecisionRow = { bank_transaction_id: string; confidence: string; forced_low: unknown; has_ai_output: boolean };

async function decisions(customer: string): Promise<DecisionRow[]> {
  return (
    await admin.query<DecisionRow>(
      `select d.bank_transaction_id, d.confidence, d.confidence_breakdown -> 'forcedLow' as forced_low, (d.ai_output is not null) as has_ai_output
       from public.ai_decisions d where d.customer_id = $1 order by d.bank_transaction_id`,
      [customer],
    )
  ).rows;
}

async function statuses(ids: string[]): Promise<string[]> {
  return (await admin.query<{ status: string }>("select status from public.bank_transactions where id = any($1::uuid[]) order by txn_date, id", [ids])).rows.map((r) => r.status);
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
async function runJob(txnCount: number, ai: JournalAi) {
  const fake = fakeSupabase();
  const result = await within(
    runProposalJob({ store: supabaseProposalStore(fake.supabase, OWNER), ai, today: TODAY }, txnCount + 1),
    "runProposalJob",
    RUN_TIMEOUT_MS,
  );
  return { result, rpcNames: fake.rpcNames };
}

/** 失敗を期待する文を SAVEPOINT で包み、観測した SQLSTATE を返す。所有者のロールで実行する（トランザクションは壊さない） */
async function sqlState(sql: string, params: unknown[]): Promise<string> {
  await admin.query("begin");
  await admin.query("savepoint fixed_asset_probe");
  try {
    await admin.query(sql, params);
  } catch (error) {
    await admin.query("rollback to savepoint fixed_asset_probe");
    await admin.query("rollback"); // 何も書き残さない
    const code = (error as { code?: unknown }).code;
    if (typeof code !== "string") throw error;
    return code;
  }
  await admin.query("rollback");
  throw new Error(`expected the statement to fail: ${sql}`);
}

const CLAIM = "claim_pending_proposal_batch";
const RENEW = "renew_proposal_claim";
const RECORD = "record_claimed_ai_decision";
const RELEASE = "release_proposal_claims";

/** 失敗する実行の共通の確認。2 件の明細のうち 2 件目は別の owner が借りている（無関係な貸出し） */
async function expectClosedFailure(scenario: number, account105Attrs: string, errorMatches: (error: string) => void): Promise<Fixture> {
  const f = await createFixture(scenario, 2, account105Attrs);
  const [t1, t2] = f.txns as [string, string];
  await admin.query("insert into public.proposal_leases (bank_transaction_id, owner, lease_expires_at) values ($1, $2, now() + interval '1 hour')", [t2, OWNER_OTHER]);
  const unrelated = await leases([t2]);
  expect(unrelated).toMatchObject([{ bank_transaction_id: t2, owner: OWNER_OTHER }]);
  const ai = mockAi();

  const { result, rpcNames } = await runJob(2, ai);

  expect(result).toMatchObject({ processed: 0, attempted: 1, truncated: false });
  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]).toMatchObject({ bankTransactionId: t1 });
  errorMatches(result.failures[0]!.error);
  expect(ai).toHaveBeenCalledTimes(0);
  // 失敗した 1 件目は実行の終わりまで借りたまま。2 件目は他の owner が借りているので 2 回目の claim は空。最後に自分の分だけ返す。renew も record もない
  expect(rpcNames).toEqual([CLAIM, CLAIM, RELEASE]);
  expect(rpcNames).not.toContain(RENEW);
  expect(rpcNames).not.toContain(RECORD);
  expect(await decisions(f.customer)).toEqual([]);
  expect(await statuses(f.txns)).toEqual(["new", "new"]);
  expect(await leases(f.txns)).toEqual(unrelated); // 自分の貸出しは返却済み。別の owner の貸出しは期限も含めて変わらない
  return f;
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe("DB が受け付ける不正な attrs.fixed_asset は、本物のストアが AI の前に拒否して閉じる（ネストした値の不正）", () => {
  const invalid: Array<{ scenario: number; name: string; value: unknown; type: string }> = [
    { scenario: 1, name: '文字列 "true"', value: "true", type: "string" },
    { scenario: 2, name: '文字列 "false"', value: "false", type: "string" },
    { scenario: 3, name: "空文字", value: "", type: "string" },
    { scenario: 4, name: "数値 1", value: 1, type: "number" },
    { scenario: 5, name: "数値 0", value: 0, type: "number" },
    { scenario: 6, name: "JSON の null", value: null, type: "null" },
    { scenario: 7, name: "オブジェクト", value: { x: 1 }, type: "object" },
    { scenario: 8, name: "配列", value: [true], type: "array" },
  ];

  it.each(invalid)(
    "$name: DB は保存し、ストアは fixed_asset を理由に失敗として数える。AI も判断の記録もなく、自分の貸出しだけ返す",
    async ({ scenario, value, type }) => {
      const json = attrsJson(value);
      const f = await expectClosedFailure(scenario, json, (error) => expect(error).toContain("fixed_asset"));

      // 本物の DB が実際にこの値を持つ（コミット済み。別の接続から観測）。attrs は書き換わっていない
      expect(await account105(f.customer)).toEqual([{ attrs: JSON.parse(json), fixed_asset_type: type }]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("有効な attrs.fixed_asset は本物のストアを通り、判断が実際に記録される", () => {
  const valid: Array<{ scenario: number; name: string; value: unknown; forced: boolean; type: string | null }> = [
    { scenario: 11, name: "true", value: true, forced: true, type: "boolean" },
    { scenario: 12, name: "false", value: false, forced: false, type: "boolean" },
    { scenario: 13, name: "キーなし", value: undefined, forced: false, type: null },
  ];

  it.each(valid)(
    "$name: 判断を 1 件記録する。固定資産の強制「低」が付くのは true のときだけ。attrs は変わらない",
    async ({ scenario, value, forced, type }) => {
      const json = attrsJson(value);
      const f = await createFixture(scenario, 1, json);
      const ai = mockAi();

      const { result, rpcNames } = await runJob(1, ai);

      expect(result).toMatchObject({ processed: 1, attempted: 1, truncated: false, failures: [] });
      expect(ai).toHaveBeenCalledTimes(1);
      expect(rpcNames).toEqual([CLAIM, RENEW, RECORD, CLAIM]);

      const rows = await decisions(f.customer);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ bank_transaction_id: f.txns[0], has_ai_output: true });
      const reasons = rows[0]!.forced_low;
      if (!Array.isArray(reasons)) throw new Error("confidence_breakdown.forcedLow is not an array");
      if (forced) {
        expect(rows[0]!.confidence).toBe("low");
        expect(reasons).toContain(FIXED_ASSET_REASON);
      } else {
        expect(reasons).not.toContain(FIXED_ASSET_REASON);
      }
      expect(await statuses(f.txns)).toEqual(["proposed"]);
      expect(await leases(f.txns)).toEqual([]);
      expect(await account105(f.customer)).toEqual([{ attrs: JSON.parse(json), fixed_asset_type: type }]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("attrs 列そのものの不正は、fixed_asset の不正とは別の層で扱われる", () => {
  it(
    "SQL の NULL: 既存の not null が 23502 で拒否する。ストアには届かず、何も保存されない",
    async () => {
      const f = await createFixture(21, 1, attrsJson(true));
      const before = await admin.query<{ n: number }>("select count(*)::int as n from public.freee_masters where customer_id = $1", [f.customer]);

      const code = await sqlState("insert into public.freee_masters (customer_id, kind, freee_id, name, attrs) values ($1, 'account_item', 199, '列が NULL', $2)", [f.customer, null]);

      expect(code).toBe("23502");
      const after = await admin.query<{ n: number }>("select count(*)::int as n from public.freee_masters where customer_id = $1", [f.customer]);
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "列全体が JSON の null（SQL の NULL ではない）: DB は保存し、ストアの形の検証が失敗として閉じる。理由は fixed_asset のキーではない",
    async () => {
      const f = await expectClosedFailure(22, "null", (error) => expect(error).not.toContain("fixed_asset"));

      const stored = await admin.query<{ is_sql_null: boolean; type: string }>(
        `select attrs is null as is_sql_null, jsonb_typeof(attrs) as type
         from public.freee_masters where customer_id = $1 and kind = 'account_item' and freee_id = 105`,
        [f.customer],
      );
      expect(stored.rows).toEqual([{ is_sql_null: false, type: "null" }]);
    },
    TEST_TIMEOUT_MS,
  );
});
