import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AiCallResult, JournalAi } from "@/lib/ai/client";
import type { AiJournalOutput } from "@/lib/ai/schema";
import { JOURNAL_MODEL, JOURNAL_PROMPT_VERSION } from "@/lib/ai/version";
import { runProposalJob } from "@/lib/proposals/run";
import { supabaseProposalStore } from "@/lib/proposals/store";
import { applyShim, createDisposableDatabase, noop, openClient, validateBaseUrl, type DisposableDatabase } from "./disposable-db";
import { CUSTOMER_A, WALLET_A } from "./helpers";

/**
 * 数値の境界（安全な整数を超える bigint）の DB 結合テスト。実行記録: docs/reviews/2026-11-06-proposal-numeric-boundary.md の「DB 結合テストの追記」。
 *
 * 何を本物にし、何を代役にしているか（読み違えないための明記）:
 *   - 本物: supabaseProposalStore の zod 検証（int / nullableInt。ここで複製しない）、runProposalJob、本物の PostgreSQL 関数
 *     claim_pending_proposal_batch / renew_proposal_claim / release_proposal_claims / record_claimed_ai_decision（service_role で実行）、
 *     本物の表と制約（customers・freee_masters・past_journal_entries・bank_transactions・proposal_leases・ai_decisions）。
 *     全マイグレーションと seed を適用した使い捨て DB を使う。制約は緩めない。
 *   - 代役: supabase-js の SupabaseClient。supabaseProposalStore が実際に呼ぶ rpc 4 種と from(...) 6 表の読取だけを許可した、
 *     pg の接続（SQL）で答える狭い偽物。許可は「表・select の列・メソッドの並び（eq / gte / lte / order / range / single）」の完全一致で、
 *     それ以外は即座に投げる（一般的な PostgREST の再実装ではない）。値は必ずパラメータで渡し、SQL に埋め込まない。
 *     日付は 'YYYY-MM-DD'、日時は ISO 形式の文字列に直して PostgREST の応答の形に寄せる。bigint 列は ::text で文字列のまま渡し、
 *     丸めを入れない（本物の検証器が文字列 "9007199254740993" を見る）。
 *   - 代役: AI は mockAI（vi.fn）。実 SDK もネットワークも使わない。
 *
 * 限界（このテストが保証しないこと）:
 *   - HTTP・PostgREST・ブラウザは通らない。実際の PostgREST は bigint を JSON の数値で返すため、9007199254740993 は supabase-js の
 *     JSON.parse で 9007199254740992 に丸められてから検証器に届く（それも安全な整数ではないので同じく拒否される）。
 *     ここで試すのは、丸めの前の「文字列として届いた場合」であり、丸めの経路そのものではない。
 *   - 各テストはトランザクションに入れてロールバックする。コミット後の永続性・別接続からの見え方・同時実行は検証しない
 *     （ai_decisions は追記専用で消せないため、ロールバックが必須）。
 *   - 過去仕訳の負の金額は、単体テストの「搬送の形」の検証器は受け付けるが、DB の check（amount > 0）が先に拒否するので、
 *     DB 経由では作れない。ここでは DB の拒否（23514）を確認するだけで、検証器の負数の扱いは単体テストの担当。
 *   - null / 空文字 / 真偽値を整数として拒否する検証器の挙動（z.coerce を使わないこと）は単体テストの担当。ここでの null・空文字・真偽値は
 *     pg が SQL のパラメータ（テキスト）として送るので、拒否するのは DB（SQLSTATE を観測して確認する）であり、検証器ではない。
 */

const DB_PREFIX = "mvp_numeric_test_";
const TODAY = "2026-11-06";
/** JS の数値リテラルにすると 9007199254740992 に丸められるので、必ず文字列で持つ */
const UNSAFE = "9007199254740993";
const MAX_SAFE = "9007199254740991";
/** runProposalJob は attempted が batchSize に達すると次の claim をしない。明細は 1 件なので 2 にして「使い切って終わる」実行にする */
const BATCH_SIZE = 2;

const IMPORT_ID = "95000000-0000-4000-8000-0000000000a1";
const TXN_ID = "95000000-0000-4000-8000-000000000001";
const PROBE_TXN_ID = "95000000-0000-4000-8000-000000000002";
const OWNER = "a5000000-0000-4000-8000-00000000000a";

let disposable: DisposableDatabase | undefined;
let client: Client;

beforeAll(async () => {
  const base = validateBaseUrl();
  disposable = await createDisposableDatabase(base, DB_PREFIX);
  try {
    client = await openClient(disposable.url, "proposal-numeric-boundary-test");
    await applyShim(client, readFileSync(join(process.cwd(), "tests/db/supabase-shim.sql"), "utf8"));
    for (const dir of ["supabase/migrations", "supabase/seed"]) {
      for (const name of readdirSync(join(process.cwd(), dir)).filter((n) => n.endsWith(".sql")).sort()) {
        await client.query(readFileSync(join(process.cwd(), dir, name), "utf8"));
      }
    }
  } catch (error) {
    await client?.end().catch(noop);
    await disposable.drop();
    throw error;
  }
}, 180_000);

afterAll(async () => {
  try {
    await client?.end().catch(noop);
  } finally {
    await disposable?.drop(); // 失敗は握りつぶさない
  }
}, 60_000);

// ---------------------------------------------------------------------------
// 狭い SQL アダプタ（SupabaseClient の偽物）
// ---------------------------------------------------------------------------

type PgResult = { data: unknown; error: { message: string } | null };

/** 1 本の接続を共有するので、「ロール設定 → 実行 → ロール戻し」を他の呼出しと混ぜない（Promise.all の読取が同時に来る） */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(noop);
  return run;
}

async function serviceRows(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; error: { message: string } | null }> {
  return serial(async () => {
    await client.query("reset role");
    await client.query("set local role service_role");
    try {
      const res = await client.query<Record<string, unknown>>(sql, params);
      return { rows: res.rows, error: null };
    } catch (error) {
      return { rows: [], error: { message: error instanceof Error ? error.message : String(error) } };
    } finally {
      await client.query("reset role").catch(noop); // 失敗でトランザクションが壊れていても元の例外を隠さない
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

function fakeSupabase(): { supabase: SupabaseClient; trace: string[] } {
  const trace: string[] = [];
  const fake = {
    rpc: (name: string, args: Record<string, unknown>) => {
      trace.push(`rpc:${name}`);
      return rpc(name, args);
    },
    from: (table: string) => {
      trace.push(`from:${table}`);
      return { select: (columns: string) => new ReadBuilder(table).select(columns) };
    },
  };
  return { supabase: fake as unknown as SupabaseClient, trace };
}

const rpcTrace = (trace: string[]) => trace.filter((t) => t.startsWith("rpc:"));

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
  description: "11月分 家賃",
  reason: "過去6件すべて地代家賃",
  unknowns: [],
  fixed_asset_possible: false,
  officer_or_personal: false,
};
const usage = { inputTokens: 3000, outputTokens: 300, cacheReadTokens: 2500, cacheWriteTokens: 0, costUsdMicros: 9500 };
const mockAi = () =>
  vi.fn(async () => ({ status: "ok", output: aiOutput, model: JOURNAL_MODEL, promptVersion: JOURNAL_PROMPT_VERSION, usage }) as AiCallResult) as JournalAi &
    ReturnType<typeof vi.fn>;

/** 既存の未判定（seed）を保留に退避し、位置を先頭に戻し、貸出しを空にして、合成の明細を 1 件作る。トランザクション内なのでロールバックされる */
async function seedOneTxn(amount: string): Promise<void> {
  await client.query("reset role");
  await client.query("update public.bank_transactions set status = 'on_hold' where status = 'new'");
  await client.query("update public.proposal_scan_cursor set last_txn_date = null, last_id = null");
  await client.query("delete from public.proposal_leases");
  await client.query(
    `insert into public.statement_imports (id, customer_id, wallet_id, source, row_count, inserted_count)
     values ($1, $2, $3, 'csv', 1, 1)`,
    [IMPORT_ID, CUSTOMER_A, WALLET_A],
  );
  await client.query(
    `insert into public.bank_transactions (id, customer_id, wallet_id, import_id, txn_date, amount, direction, description, dedupe_key)
     values ($1, $2, $3, $4, '2026-10-30', $5, 'expense', 'ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ', 'numeric-boundary-1')`,
    [TXN_ID, CUSTOMER_A, WALLET_A, IMPORT_ID, amount],
  );
}

async function inTx(txnAmount: string, fn: () => Promise<void>): Promise<void> {
  await client.query("begin");
  try {
    await seedOneTxn(txnAmount);
    await fn();
  } finally {
    await client.query("reset role").catch(noop);
    await client.query("rollback"); // ai_decisions は消せないので、必ずロールバックする
  }
}

const PAST_SQL = `insert into public.past_journal_entries
  (customer_id, source, freee_source_id, entry_date, amount, direction, bank_description, partner_key, partner_id, account_item_id, tax_code, item_id, section_id, tag_ids, description)
  values ($1, 'freee_deal', $2, '2026-10-01', $3, 'expense', 'ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ', 'サンプルフドウサン', null, 105, $4, null, null, '{}', '境界値の過去仕訳')`;
const pastParams = (amount: unknown, taxCode: unknown = 21, freeeSourceId = 9100001): unknown[] => [CUSTOMER_A, freeeSourceId, amount, taxCode];

const MASTER_SQL = "insert into public.freee_masters (customer_id, kind, freee_id, name) values ($1, 'partner', $2, '境界値の取引先')";
const TXN_SQL = `insert into public.bank_transactions (id, customer_id, wallet_id, import_id, txn_date, amount, direction, description, dedupe_key)
  values ($1, $2, $3, $4, '2026-10-31', $5, 'expense', '境界値の明細', 'numeric-boundary-probe')`;
const THRESHOLD_SQL = "update public.customers set low_confidence_amount_threshold = $2 where id = $1";

type DbState = { status: string; leases: Array<{ owner: string; ttl_seconds: number; unexpired: boolean }>; decisions: number };

async function dbState(): Promise<DbState> {
  await client.query("reset role");
  const status = (await client.query<{ status: string }>("select status from public.bank_transactions where id = $1", [TXN_ID])).rows[0]!.status;
  const leases = await client.query<{ owner: string; ttl_seconds: number; unexpired: boolean }>(
    `select owner, extract(epoch from (lease_expires_at - claimed_at))::int as ttl_seconds, lease_expires_at > now() as unexpired
     from public.proposal_leases where bank_transaction_id = $1`,
    [TXN_ID],
  );
  const decisions = (await client.query<{ n: number }>("select count(*)::int as n from public.ai_decisions where bank_transaction_id = $1", [TXN_ID])).rows[0]!.n;
  return { status, leases: leases.rows, decisions };
}

async function readText(sql: string, params: unknown[]): Promise<string[]> {
  await client.query("reset role");
  return (await client.query<{ v: string }>(sql, params)).rows.map((r) => r.v);
}

/** 失敗を期待する文を SAVEPOINT で包み、観測した SQLSTATE を返す（トランザクションは壊さない）。所有者のロールで実行する */
async function sqlState(sql: string, params: unknown[]): Promise<string> {
  await client.query("reset role");
  await client.query("savepoint numeric_probe");
  try {
    await client.query(sql, params);
  } catch (error) {
    await client.query("rollback to savepoint numeric_probe");
    await client.query("release savepoint numeric_probe");
    const code = (error as { code?: unknown }).code;
    if (typeof code !== "string") throw error;
    return code;
  }
  await client.query("release savepoint numeric_probe");
  throw new Error(`expected the statement to fail: ${sql}`);
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe("前提", () => {
  it("9007199254740993 は JS の数値では表せず、Number にすると安全な整数でなくなる（文字列で扱う理由）", () => {
    expect(Number(UNSAFE)).toBe(9007199254740992);
    expect(Number.isSafeInteger(Number(UNSAFE))).toBe(false);
    expect(Number.isSafeInteger(Number(MAX_SAFE))).toBe(true);
  });
});

describe("安全な整数を超える値を DB は受け付けるが、本物の supabaseProposalStore と runProposalJob は AI の前で拒否する", () => {
  it("明細の金額が 9007199254740993: claim の解析が owned に入れる前に投げるが、ストアが自分の owner で貸出しをすぐ返す。AI も記録も無い", () =>
    inTx(UNSAFE, async () => {
      expect(await readText("select amount::text as v from public.bank_transactions where id = $1", [TXN_ID])).toEqual([UNSAFE]); // DB の実際の値
      const { supabase, trace } = fakeSupabase();
      const ai = mockAi();

      await expect(runProposalJob({ store: supabaseProposalStore(supabase, OWNER), ai, today: TODAY }, BATCH_SIZE)).rejects.toThrow(/amount/);

      expect(ai).toHaveBeenCalledTimes(0);
      // 解析が投げた時点で owned は空なので run.ts の finally は release を呼ばない。代わりに store が、返り値の生の ID を自分の owner で返す
      expect(rpcTrace(trace)).toEqual(["rpc:claim_pending_proposal_batch", "rpc:release_proposal_claims"]);
      expect(await dbState()).toEqual({ status: "new", leases: [], decisions: 0 });
    }), 30_000);

  const contextCases: Array<{ name: string; field: string; arrange: () => Promise<void>; readback: () => Promise<string[]> }> = [
    {
      name: "顧客の low_confidence_amount_threshold",
      field: "low_confidence_amount_threshold",
      arrange: async () => void (await client.query(THRESHOLD_SQL, [CUSTOMER_A, UNSAFE])),
      readback: () => readText("select low_confidence_amount_threshold::text as v from public.customers where id = $1", [CUSTOMER_A]),
    },
    {
      name: "マスタの freee_id",
      field: "freee_id",
      arrange: async () => void (await client.query(MASTER_SQL, [CUSTOMER_A, UNSAFE])),
      readback: () => readText("select freee_id::text as v from public.freee_masters where customer_id = $1 and kind = 'partner' and freee_id = $2", [CUSTOMER_A, UNSAFE]),
    },
    {
      name: "過去仕訳の amount",
      field: "amount",
      arrange: async () => void (await client.query(PAST_SQL, pastParams(UNSAFE))),
      readback: () => readText("select amount::text as v from public.past_journal_entries where freee_source_id = 9100001", []),
    },
  ];

  it.each(contextCases)(
    "$name が 9007199254740993: 文脈の検証で失敗として数え、AI を呼ばず・記録せず、貸出しを実際に返す。明細は new のまま",
    ({ field, arrange, readback }) =>
      inTx("165000", async () => {
        await arrange();
        expect(await readback()).toEqual([UNSAFE]); // DB の bigint が実際にこの値を持つ（制約は緩めていない）
        const { supabase, trace } = fakeSupabase();
        const ai = mockAi();

        const result = await runProposalJob({ store: supabaseProposalStore(supabase, OWNER), ai, today: TODAY }, BATCH_SIZE);

        expect(result).toMatchObject({ processed: 0, attempted: 1, truncated: false });
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toMatchObject({ bankTransactionId: TXN_ID });
        expect(result.failures[0]!.error).toContain(field);
        expect(ai).toHaveBeenCalledTimes(0);
        // 失敗した明細は実行の終わりまで借りたままなので、attempted(1) < BATCH_SIZE(2) のループは 2 回目の claim をする。
        // 貸出し中の明細は渡らず空が返って終わり、finally が release を呼ぶ。renew も record も呼ばれない
        expect(rpcTrace(trace)).toEqual(["rpc:claim_pending_proposal_batch", "rpc:claim_pending_proposal_batch", "rpc:release_proposal_claims"]);
        expect(await dbState()).toEqual({ status: "new", leases: [], decisions: 0 });
      }),
    30_000,
  );
});

describe("通常の整数・bigint の文字列・任意の null / 0 は保たれる（本物の supabaseProposalStore → runProposalJob → 本物の DB 関数）", () => {
  async function arrangeNormal(): Promise<void> {
    await client.query(MASTER_SQL, [CUSTOMER_A, MAX_SAFE]);
    await client.query(PAST_SQL, pastParams(MAX_SAFE, 0)); // tax_code 0・partner / item / section は null・tag_ids は空
    // 通常の AI の判断（tax_code 0）がマスタの検証を通るよう、有効な税区分 0 のマスタを用意する。seed に既にあれば重複させない
    await client.query(
      `insert into public.freee_masters (customer_id, kind, freee_id, name)
       select $1::uuid, 'tax', 0, '境界値の税区分 0'
       where not exists (select 1 from public.freee_masters where customer_id = $1::uuid and kind = 'tax' and freee_id = 0)`,
      [CUSTOMER_A],
    );
  }

  /** 税区分 0・任意の ID はすべて null の、通常の AI の判断（マスタの検証を通る） */
  const normalOutput: AiJournalOutput = { ...aiOutput, tax_code: 0, partner_id: null, item_id: null, section_id: null, tag_ids: [] };
  const mockNormalAi = () =>
    vi.fn(async () => ({ status: "ok", output: normalOutput, model: JOURNAL_MODEL, promptVersion: JOURNAL_PROMPT_VERSION, usage }) as AiCallResult) as JournalAi &
      ReturnType<typeof vi.fn>;

  it("loadCustomerContext: bigint の文字列 9007199254740991 は同じ値の数値に、tax_code 0 は 0 のまま（-0 でない）、null は null のまま", () =>
    inTx("165000", async () => {
      await arrangeNormal();
      const { supabase } = fakeSupabase();
      const ctx = await supabaseProposalStore(supabase, OWNER).loadCustomerContext(CUSTOMER_A, TODAY);

      expect(ctx.customer.lowConfidenceAmountThreshold).toBe(300000); // seed の既定値（bigint の文字列 → 数値）
      expect(ctx.masters).toContainEqual(expect.objectContaining({ kind: "partner", id: Number.MAX_SAFE_INTEGER, name: "境界値の取引先" }));
      const past = ctx.pastEntries.find((p) => p.amount === Number.MAX_SAFE_INTEGER);
      if (!past) throw new Error("the boundary past entry was not loaded");
      expect(past.entry).toEqual({ accountItemId: 105, taxCode: 0, partnerId: null, itemId: null, sectionId: null, tagIds: [], description: "境界値の過去仕訳" });
      expect(Object.is(past.entry.taxCode, 0)).toBe(true);
      expect(ctx.walletNames.get(WALLET_A)).toBe("サンプル銀行 本店 普通");
    }), 30_000);

  it("明細の金額が 9007199254740991（安全な整数の最大）: 解析され、mockAI の通常の判断（tax_code 0・任意の ID は null）が 1 件保存され、貸出しは終わる", () =>
    inTx(MAX_SAFE, async () => {
      await arrangeNormal();
      const { supabase, trace } = fakeSupabase();
      const ai = mockNormalAi();

      const result = await runProposalJob({ store: supabaseProposalStore(supabase, OWNER), ai, today: TODAY }, BATCH_SIZE);

      expect(result).toMatchObject({ processed: 1, attempted: 1, truncated: false, failures: [] });
      expect(ai).toHaveBeenCalledTimes(1);
      expect(rpcTrace(trace)).toEqual([
        "rpc:claim_pending_proposal_batch",
        "rpc:renew_proposal_claim",
        "rpc:record_claimed_ai_decision",
        "rpc:claim_pending_proposal_batch",
      ]);
      expect(await dbState()).toEqual({ status: "proposed", leases: [], decisions: 1 });
      await client.query("reset role");
      const row = await client.query<{
        model: string | null;
        has_ai_output: boolean;
        amount_text: string;
        proposal: Record<string, unknown> | null;
      }>(
        `select model, (ai_output is not null) as has_ai_output, transaction_snapshot ->> 'amount' as amount_text, proposal
         from public.ai_decisions where bank_transaction_id = $1`,
        [TXN_ID],
      );
      expect(row.rows).toEqual([
        {
          model: JOURNAL_MODEL,
          has_ai_output: true,
          amount_text: MAX_SAFE,
          proposal: { account_item_id: 105, tax_code: 0, partner_id: null, item_id: null, section_id: null, tag_ids: [], description: "11月分 家賃" },
        },
      ]);
    }), 30_000);
});

describe("必須の型付き列を DB は null・空文字・真偽値で拒否する（制約は緩めない。SAVEPOINT で観測した SQLSTATE を確認する）", () => {
  // null は NOT NULL 違反（23502）。空文字・真偽値は pg がテキストのパラメータとして送るので、整数型の入力で 22P02（不正なテキスト表現）。
  // どれも SQL 側の変換・制約の結果であり、supabaseProposalStore の検証器（モックの搬送の形）の結果ではない。
  const NOT_NULL = "23502";
  const BAD_TEXT = "22P02";
  const CHECK = "23514";
  const dbCases: Array<{ name: string; sql: string; params: unknown[]; code: string }> = [
    { name: "bank_transactions.amount = null", sql: TXN_SQL, params: [PROBE_TXN_ID, CUSTOMER_A, WALLET_A, IMPORT_ID, null], code: NOT_NULL },
    { name: "bank_transactions.amount = ''", sql: TXN_SQL, params: [PROBE_TXN_ID, CUSTOMER_A, WALLET_A, IMPORT_ID, ""], code: BAD_TEXT },
    { name: "bank_transactions.amount = true", sql: TXN_SQL, params: [PROBE_TXN_ID, CUSTOMER_A, WALLET_A, IMPORT_ID, true], code: BAD_TEXT },
    { name: "customers.low_confidence_amount_threshold = null", sql: THRESHOLD_SQL, params: [CUSTOMER_A, null], code: NOT_NULL },
    { name: "customers.low_confidence_amount_threshold = ''", sql: THRESHOLD_SQL, params: [CUSTOMER_A, ""], code: BAD_TEXT },
    { name: "customers.low_confidence_amount_threshold = true", sql: THRESHOLD_SQL, params: [CUSTOMER_A, true], code: BAD_TEXT },
    { name: "freee_masters.freee_id = null", sql: MASTER_SQL, params: [CUSTOMER_A, null], code: NOT_NULL },
    { name: "freee_masters.freee_id = ''", sql: MASTER_SQL, params: [CUSTOMER_A, ""], code: BAD_TEXT },
    { name: "freee_masters.freee_id = true", sql: MASTER_SQL, params: [CUSTOMER_A, true], code: BAD_TEXT },
    { name: "past_journal_entries.amount = null", sql: PAST_SQL, params: pastParams(null), code: NOT_NULL },
    { name: "past_journal_entries.amount = ''", sql: PAST_SQL, params: pastParams(""), code: BAD_TEXT },
    { name: "past_journal_entries.amount = true", sql: PAST_SQL, params: pastParams(true), code: BAD_TEXT },
    { name: "past_journal_entries.tax_code (integer) = null", sql: PAST_SQL, params: pastParams("1000", null), code: NOT_NULL },
    { name: "past_journal_entries.tax_code (integer) = true", sql: PAST_SQL, params: pastParams("1000", true), code: BAD_TEXT },
    // 負の金額: 単体テストの搬送の形の検証器は通すが、DB の check（amount > 0）が先に拒否する
    { name: "past_journal_entries.amount = -9007199254740993（DB の check が拒否）", sql: PAST_SQL, params: pastParams(`-${UNSAFE}`), code: CHECK },
    { name: "past_journal_entries.amount = 0（DB の check が拒否）", sql: PAST_SQL, params: pastParams("0"), code: CHECK },
  ];

  it.each(dbCases)("$name → SQLSTATE $code", ({ sql, params, code }) =>
    inTx("165000", async () => {
      expect(await sqlState(sql, params)).toBe(code);
    }), 30_000);
});
