import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_ID, CUSTOMER_A, STAFF_ID, WALLET_A } from "./helpers";

/**
 * 実際に2つの独立した DB セッションを同時に走らせる競合のテスト。
 * 共有のテストデータを汚さないよう、テストごとの使い捨てデータベースを作って
 * （土台・マイグレーション・seed を適用）、最後にそのデータベースだけを削除する。
 * 判断ログは追記専用で後から消せないので、データベースごと捨てる。
 *
 * 重なりの証明は sleep ではなく、pg_stat_activity / pg_blocking_pids で
 * 「後のセッションが先のセッションの確定を待っている」状態を観測して行う。
 */

const DB_PREFIX = "mvp_conc_test_";
const OP_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 60_000;

let baseUrl: URL;
let dbName = "";
let dbCreated = false;
let dbUrl = "";

/** ローカルの検証用サーバーだけを許可する（本番・外部ホストには接続しない） */
function validateBaseUrl(): URL {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) {
    throw new Error("TEST_DATABASE_URL is required (npm run db:test:local で起動できます)");
  }
  const url = new URL(raw);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must be a postgres URL");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`refusing to run: TEST_DATABASE_URL host must be 127.0.0.1 or localhost (got ${url.hostname})`);
  }
  // 接続先を query で上書きさせない
  for (const key of ["host", "hostaddr", "service", "dbname"]) {
    if (url.searchParams.has(key)) {
      throw new Error(`refusing to run: TEST_DATABASE_URL must not set "${key}"`);
    }
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (name !== "postgres" && !/test/i.test(name)) {
    throw new Error(`refusing to run: database "${name}" is not a test target (name must contain "test", or be the local default "postgres")`);
  }
  return url;
}

function urlFor(database: string): string {
  const url = new URL(baseUrl.toString());
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

const noop = () => undefined;

async function openClient(url: string, label: string): Promise<Client> {
  const client = new Client({
    connectionString: url,
    application_name: label,
    connectionTimeoutMillis: 10_000,
    statement_timeout: OP_TIMEOUT_MS,
    idle_in_transaction_session_timeout: 60_000,
  });
  client.on("error", noop); // 後始末で接続を落とすときの通知で落ちないようにする
  await client.connect();
  return client;
}

async function applyFixtures(client: Client): Promise<void> {
  let shim = readFileSync(join(process.cwd(), "tests/db/supabase-shim.sql"), "utf8");
  // ロールはクラスタ共通。すでにある場合（同じサーバーの共有 DB に適用済み）は作成文だけ省く
  const existing = await client.query<{ rolname: string }>("select rolname from pg_roles where rolname = any($1)", [
    ["anon", "authenticated", "service_role"],
  ]);
  for (const { rolname } of existing.rows) {
    shim = shim.replace(new RegExp(`^create role ${rolname}\\b[^;]*;\\s*$`, "m"), "");
  }
  await client.query(shim);

  const sqlFiles = (dir: string) =>
    readdirSync(join(process.cwd(), dir))
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => join(process.cwd(), dir, f));
  for (const file of [...sqlFiles("supabase/migrations"), ...sqlFiles("supabase/seed")]) {
    await client.query(readFileSync(file, "utf8"));
  }
}

async function dropDisposableDatabase(): Promise<void> {
  if (!dbCreated || !dbName.startsWith(DB_PREFIX)) return;
  const admin = await openClient(baseUrl.toString(), "conc-drop");
  try {
    // 生成した名前のデータベースだけを削除する
    await admin.query(`drop database if exists ${admin.escapeIdentifier(dbName)} with (force)`);
    dbCreated = false;
  } finally {
    await admin.end().catch(noop);
  }
}

beforeAll(async () => {
  baseUrl = validateBaseUrl();
  dbName = `${DB_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = await openClient(baseUrl.toString(), "conc-create");
  try {
    await admin.query(`create database ${admin.escapeIdentifier(dbName)}`);
    dbCreated = true;
  } catch (error) {
    await admin.end().catch(noop);
    throw new Error(`could not create the disposable database (CREATEDB 権限が必要です): ${String(error)}`);
  }
  await admin.end().catch(noop);

  dbUrl = urlFor(dbName);
  const setup = await openClient(dbUrl, "conc-setup");
  try {
    await applyFixtures(setup);
  } catch (error) {
    await setup.end().catch(noop);
    await dropDisposableDatabase();
    throw error;
  }
  await setup.end().catch(noop);
}, 120_000);

afterAll(async () => {
  await dropDisposableDatabase();
}, 60_000);

// ---------------------------------------------------------------------------------------------
// セッションと観測の道具

type Session = { client: Client; pid: number };

async function openSession(label: string): Promise<Session> {
  const client = await openClient(dbUrl, label);
  const res = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
  return { client, pid: res.rows[0]!.pid };
}

/**
 * テスト用のセッションを開く。admin は自動コミットの観測・検証・初期データ用。
 * 失敗しても、開いたセッションは必ず終了させる（未確定のトランザクションは接続の終了で取り消される）。
 */
async function withSessions(fn: (admin: Session, open: (label: string) => Promise<Session>) => Promise<void>): Promise<void> {
  const opened: Session[] = [];
  const open = async (label: string) => {
    const s = await openSession(label);
    opened.push(s);
    return s;
  };
  const admin = await open("conc-admin");
  try {
    await fn(admin, open);
  } finally {
    for (const s of opened) {
      if (s !== admin) {
        await admin.client.query("select pg_terminate_backend($1)", [s.pid]).catch(noop);
      }
    }
    for (const s of opened) {
      await s.client.end().catch(noop);
    }
  }
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: Error };
type Tracked<T> = { settled: boolean; outcome: Promise<Outcome<T>> };

/** 完了を待たずに開始した操作を追跡する（未処理の rejection を作らない） */
function track<T>(promise: Promise<T>): Tracked<T> {
  const tracked: Tracked<T> = {
    settled: false,
    outcome: promise
      .then(
        (value): Outcome<T> => ({ ok: true, value }),
        (error): Outcome<T> => ({ ok: false, error: error instanceof Error ? error : new Error(String(error)) }),
      )
      .then((o) => {
        tracked.settled = true;
        return o;
      }),
  };
  return tracked;
}

async function within<T>(promise: Promise<T>, label: string, ms = OP_TIMEOUT_MS): Promise<T> {
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

/** blocked のセッションが blocker のセッションを待っている（ロック待ち）状態を観測するまで待つ。待ち種別を返す */
async function waitUntilBlocked(monitor: Session, blocked: Session, blocker: Session, op: Tracked<unknown>, label: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await monitor.client.query<{ wait_event_type: string | null; wait_event: string | null; blockers: number[] }>(
      "select wait_event_type, wait_event, pg_blocking_pids(pid) as blockers from pg_stat_activity where pid = $1",
      [blocked.pid],
    );
    const row = res.rows[0];
    if (row && row.wait_event_type === "Lock" && row.blockers.includes(blocker.pid)) {
      expect(op.settled, `${label}: 待っている間に完了していない`).toBe(false);
      return row.wait_event ?? "";
    }
    if (op.settled) {
      throw new Error(`${label}: 先のセッションを待たずに完了した（重なりを観測できなかった）`);
    }
    await delay(25);
  }
  throw new Error(`${label}: ロック待ちを観測できなかった`);
}

async function sessionState(monitor: Session, target: Session): Promise<string | undefined> {
  const res = await monitor.client.query<{ state: string }>("select state from pg_stat_activity where pid = $1", [target.pid]);
  return res.rows[0]?.state;
}

type Actor = "staff" | "admin" | "service";

/** トランザクションを開始し、ロール（authenticated / service_role）と JWT の sub を設定する */
async function begin(client: Client, actor: Actor): Promise<void> {
  await client.query("begin");
  if (actor === "service") {
    await client.query("set local role service_role");
    return;
  }
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [actor === "staff" ? STAFF_ID : ADMIN_ID]);
  await client.query("set local role authenticated");
}

async function commit(client: Client): Promise<void> {
  await client.query("commit");
}

async function rollbackQuietly(client: Client): Promise<void> {
  await within(client.query("rollback"), "rollback", 5_000).catch(noop);
}

/** 1つのトランザクションとして fn を実行する。失敗したらロールバックする */
async function inTx<T>(client: Client, actor: Actor, fn: () => Promise<T>): Promise<T> {
  await begin(client, actor);
  try {
    const result = await fn();
    await commit(client);
    return result;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// 取込

type ImportRow = {
  txn_date: string;
  amount: number;
  direction: "income" | "expense";
  description: string;
  balance: number | null;
  dedupe_key: string;
};

type ImportResult = {
  import_id: string;
  inserted_count: number;
  skipped_duplicate_count: number;
  suspected_duplicate_count: number;
  income_total: string;
  expense_total: string;
  inserted_amount_total: string;
  skipped_amount_total: string;
  suspected_amount_total: string;
};

const importSql = (client: Client, file: string, rows: ImportRow[]) =>
  client.query<ImportResult>("select * from public.import_bank_statement($1, $2, 'csv', $3, 'bank_generic', $4, $5, '[]')", [
    CUSTOMER_A,
    WALLET_A,
    file,
    JSON.stringify(rows),
    rows.length,
  ]);

const uniqueTag = () => randomUUID().replace(/-/g, "").slice(0, 10);

async function txnsOf(admin: Session, tag: string) {
  const res = await admin.client.query<{
    id: string;
    import_id: string;
    dedupe_key: string;
    status: string;
    amount: string;
    duplicate_of_id: string | null;
  }>("select id, import_id, dedupe_key, status, amount, duplicate_of_id from public.bank_transactions where dedupe_key like $1 order by dedupe_key", [
    `${tag}-%`,
  ]);
  return res.rows;
}

describe("同時取込（2セッション）", () => {
  it(
    "先の取込が未確定の間、同じ内容の取込は待たされ、先の確定後に再実行として読み飛ばし、明細を二重に登録しない",
    async () => {
      const tag = uniqueTag();
      const rows: ImportRow[] = [
        { txn_date: "2026-10-27", amount: 9020, direction: "expense", description: "SAMPLE TELECOM", balance: 100000, dedupe_key: `${tag}-a1` },
        { txn_date: "2026-10-31", amount: 330000, direction: "income", description: "SAMPLE CLIENT", balance: 430000, dedupe_key: `${tag}-a2` },
      ];
      await withSessions(async (admin, open) => {
        const a = await open("conc-import-a");
        const b = await open("conc-import-b");

        await begin(a.client, "staff");
        const first = (await importSql(a.client, "first.csv", rows)).rows[0]!; // 未確定のまま保持
        expect(first).toMatchObject({ inserted_count: 2, skipped_duplicate_count: 0, suspected_duplicate_count: 0 });
        expect(await sessionState(admin, a)).toBe("idle in transaction");

        await begin(b.client, "staff");
        const second = track(importSql(b.client, "second.csv", rows));
        const waitEvent = await waitUntilBlocked(admin, b, a, second, "同じ内容の取込");
        expect(waitEvent).toBe("advisory"); // 顧客単位の取込ロック

        await commit(a.client);
        const outcome = await within(second.outcome, "second import");
        if (!outcome.ok) throw outcome.error;
        await commit(b.client);

        const result = outcome.value.rows[0]!;
        expect(result.import_id).not.toBe(first.import_id);
        expect(result).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 2, suspected_duplicate_count: 0 });
        expect(Number(result.inserted_amount_total)).toBe(0);
        expect(Number(result.skipped_amount_total)).toBe(9020 + 330000);
        expect(Number(result.suspected_amount_total)).toBe(0);

        // 明細は先の取込が登録した2件だけ。二重に増えていない
        const txns = await txnsOf(admin, tag);
        expect(txns.map((t) => t.dedupe_key)).toEqual([`${tag}-a1`, `${tag}-a2`]);
        expect(txns.every((t) => t.status === "new" && t.import_id === first.import_id)).toBe(true);
        expect(txns.reduce((sum, t) => sum + Number(t.amount), 0)).toBe(9020 + 330000);

        // 取込記録は2件、読めた行 = 登録 + 読み飛ばし + 重複の疑い
        const imports = await admin.client.query<{ id: string; row_count: number; inserted_count: number; skipped_duplicate_count: number; suspected_duplicate_count: number; batch_hash: string }>(
          "select id, row_count, inserted_count, skipped_duplicate_count, suspected_duplicate_count, batch_hash from public.statement_imports where id = any($1) order by file_name",
          [[first.import_id, result.import_id]],
        );
        expect(imports.rows).toHaveLength(2);
        expect(imports.rows[0]!.batch_hash).toBe(imports.rows[1]!.batch_hash);
        for (const rec of imports.rows) {
          expect(rec.inserted_count + rec.skipped_duplicate_count + rec.suspected_duplicate_count).toBe(rec.row_count);
        }
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "残高が同じでも内容の違う別の取込は、待たされた後も読み飛ばさず「重複の疑い」として残し、件数・金額が保存される",
    async () => {
      const tag = uniqueTag();
      const shared: ImportRow = { txn_date: "2026-10-27", amount: 1000, direction: "expense", description: "SAMPLE SHOP", balance: 9000, dedupe_key: `${tag}-s1` };
      const rowsA: ImportRow[] = [shared];
      const rowsB: ImportRow[] = [
        { txn_date: "2026-10-26", amount: 1000, direction: "income", description: "SAMPLE DEPOSIT", balance: 10000, dedupe_key: `${tag}-i1` },
        { ...shared }, // 別の CSV にある、キーも残高も同じ別の取引
      ];
      await withSessions(async (admin, open) => {
        const a = await open("conc-distinct-a");
        const b = await open("conc-distinct-b");

        await begin(a.client, "staff");
        const first = (await importSql(a.client, "a.csv", rowsA)).rows[0]!;
        expect(first).toMatchObject({ inserted_count: 1, skipped_duplicate_count: 0, suspected_duplicate_count: 0 });

        await begin(b.client, "staff");
        const second = track(importSql(b.client, "b.csv", rowsB));
        expect(await waitUntilBlocked(admin, b, a, second, "内容の違う取込")).toBe("advisory");

        await commit(a.client);
        const outcome = await within(second.outcome, "second import");
        if (!outcome.ok) throw outcome.error;
        await commit(b.client);

        const result = outcome.value.rows[0]!;
        expect(result).toMatchObject({ inserted_count: 1, skipped_duplicate_count: 0, suspected_duplicate_count: 1 });
        expect(Number(result.income_total)).toBe(1000);
        expect(Number(result.expense_total)).toBe(1000);
        expect(Number(result.inserted_amount_total)).toBe(1000);
        expect(Number(result.skipped_amount_total)).toBe(0);
        expect(Number(result.suspected_amount_total)).toBe(1000);

        // 取り込んだ全行が残っている（黙って消えていない）: 先の1件 + 後の2件 = 3件、金額 3,000
        const txns = await txnsOf(admin, tag);
        expect(txns).toHaveLength(3);
        expect(txns.reduce((sum, t) => sum + Number(t.amount), 0)).toBe(1000 + 1000 + 1000);
        const original = txns.find((t) => t.dedupe_key === `${tag}-s1`)!;
        const income = txns.find((t) => t.dedupe_key === `${tag}-i1`)!;
        const suspected = txns.find((t) => t.dedupe_key === `${tag}-s1:suspected:${result.import_id}`)!;
        expect(original).toMatchObject({ status: "new", import_id: first.import_id });
        expect(income).toMatchObject({ status: "new", import_id: result.import_id });
        expect(suspected).toMatchObject({ status: "duplicate_suspected", import_id: result.import_id, duplicate_of_id: original.id });

        // 取込記録の照合: 読めた行 = 登録 + 読み飛ばし + 重複の疑い（件数・金額とも）
        const rec = await admin.client.query<{ row_count: number; inserted_count: number; skipped_duplicate_count: number; suspected_duplicate_count: number }>(
          "select row_count, inserted_count, skipped_duplicate_count, suspected_duplicate_count from public.statement_imports where id = $1",
          [result.import_id],
        );
        expect(rec.rows[0]).toEqual({ row_count: 2, inserted_count: 1, skipped_duplicate_count: 0, suspected_duplicate_count: 1 });
        expect(Number(result.inserted_amount_total) + Number(result.skipped_amount_total) + Number(result.suspected_amount_total)).toBe(
          Number(result.income_total) + Number(result.expense_total),
        );
      });
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------------------------
// AI判断の記録

/**
 * 明細を1件、未判定（new）で確定済みの状態で作る。テストごとに固有の重複キーを使う。
 * （helpers.insertSampleDecision は固定キー `test-1` で、呼出し側のトランザクション内に作り、
 * 明細も候補作成済ではないので、確定済みデータが必要な並行テストには使わない）
 */
async function createNewTxn(admin: Session, tag: string): Promise<string> {
  const imp = await admin.client.query<{ id: string }>("insert into public.statement_imports (customer_id, wallet_id, source) values ($1, $2, 'csv') returning id", [
    CUSTOMER_A,
    WALLET_A,
  ]);
  const txn = await admin.client.query<{ id: string }>(
    `insert into public.bank_transactions (customer_id, wallet_id, import_id, txn_date, amount, direction, description, dedupe_key)
     values ($1, $2, $3, '2026-10-27', 9020, 'expense', 'SAMPLE TELECOM', $4) returning id`,
    [CUSTOMER_A, WALLET_A, imp.rows[0]!.id, `${tag}-txn`],
  );
  return txn.rows[0]!.id;
}

const decisionJson = (txnId: string, accountItemId: number) =>
  JSON.stringify({
    customer_id: CUSTOMER_A,
    bank_transaction_id: txnId,
    transaction_snapshot: { amount: 9020 },
    proposal: { account_item_id: accountItemId, tax_code: 21 },
    confidence: "high",
    confidence_breakdown: {},
    model: null,
    prompt_version: null,
  });

const recordSql = (client: Client, txnId: string, accountItemId: number) =>
  client.query<{ id: string }>("select public.record_ai_decision($1) as id", [decisionJson(txnId, accountItemId)]);

const NOT_WAITING = /is not waiting for a proposal/;

async function decisionsOf(admin: Session, txnId: string) {
  const res = await admin.client.query<{ id: string; proposal: { account_item_id: number } }>(
    "select id, proposal from public.ai_decisions where bank_transaction_id = $1 order by created_at, id",
    [txnId],
  );
  return res.rows;
}

async function statusOf(admin: Session, txnId: string): Promise<string> {
  return (await admin.client.query<{ status: string }>("select status from public.bank_transactions where id = $1", [txnId])).rows[0]!.status;
}

describe("同時のAI判断の記録（2セッション）", () => {
  it(
    "同じ未判定の明細に2つの記録が同時に来ても、受理されるのは1つだけで、後の記録は待たされた後に拒否される",
    async () => {
      const tag = uniqueTag();
      await withSessions(async (admin, open) => {
        const txnId = await createNewTxn(admin, tag);
        const a = await open("conc-ai-a");
        const b = await open("conc-ai-b");

        await begin(a.client, "service");
        const acceptedId = (await recordSql(a.client, txnId, 101)).rows[0]!.id; // 未確定のまま保持

        await begin(b.client, "service");
        const second = track(recordSql(b.client, txnId, 102));
        expect(["transactionid", "tuple"]).toContain(await waitUntilBlocked(admin, b, a, second, "2つ目の記録"));

        await commit(a.client);
        const outcome = await within(second.outcome, "second record_ai_decision");
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.error.message).toMatch(NOT_WAITING);
        await rollbackQuietly(b.client);

        // 受理されたのは先の1件だけで、判断ログは1行、後の提案は残っていない
        const decisions = await decisionsOf(admin, txnId);
        expect(decisions).toHaveLength(1);
        expect(decisions[0]).toMatchObject({ id: acceptedId, proposal: { account_item_id: 101 } });
        expect(await statusOf(admin, txnId)).toBe("proposed");
      });
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------------------------
// 保留と、遅れて届いた AI の保存

const HOLD_REASON = "請求書の到着待ち";

describe("人の保留と遅れたAI保存（2セッション）", () => {
  it(
    "候補作成済の明細を人が保留している間（未確定）に遅れた保存が来ても拒否し、保留の理由・確認ログ・判断ログを変えず、まとめて承認もできないまま",
    async () => {
      const tag = uniqueTag();
      await withSessions(async (admin, open) => {
        const txnId = await createNewTxn(admin, tag);
        const setup = await open("conc-hold-setup");
        const human = await open("conc-hold-human");
        const job = await open("conc-hold-stale-job");

        // ジョブ A が先に保存を確定し、候補作成済（proposed）にしておく
        const decisionId = await inTx(setup.client, "service", async () => (await recordSql(setup.client, txnId, 101)).rows[0]!.id);
        expect(await statusOf(admin, txnId)).toBe("proposed");

        // 人が保留にする（未確定のまま保持）
        await begin(human.client, "staff");
        const hold = await human.client.query<{ id: string }>("select public.record_human_review($1, 'hold', null, $2, 3, false) as id", [decisionId, HOLD_REASON]);
        const holdId = hold.rows[0]!.id;
        expect(await sessionState(admin, human)).toBe("idle in transaction");

        // 同じ明細を未判定として読み込んでいた遅れたジョブ B が、保存を実行する
        await begin(job.client, "service");
        const stale = track(recordSql(job.client, txnId, 102));
        // 確定済みの状態が proposed なので、更新条件（status = 'new'）に合わず、待たずに拒否される場合がある。
        // 待たされた場合は、保留の確定まで待ってから拒否される。どちらでも、保留の確定前か後かにかかわらず拒否される
        let blocked = false;
        for (let i = 0; i < 400 && !stale.settled && !blocked; i++) {
          const res = await admin.client.query<{ wait_event_type: string | null; blockers: number[] }>(
            "select wait_event_type, pg_blocking_pids(pid) as blockers from pg_stat_activity where pid = $1",
            [job.pid],
          );
          blocked = res.rows[0]?.wait_event_type === "Lock" && res.rows[0].blockers.includes(human.pid);
          if (!blocked && !stale.settled) await delay(25);
        }
        expect(stale.settled || blocked, "遅れた保存が拒否されたか、保留の確定を待っている").toBe(true);
        if (stale.settled) {
          // 保留がまだ未確定の間に拒否された
          expect(await sessionState(admin, human)).toBe("idle in transaction");
        }

        await commit(human.client); // 保留を確定
        const outcome = await within(stale.outcome, "stale record_ai_decision");
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.error.message).toMatch(NOT_WAITING);
        await rollbackQuietly(job.client);

        // 保留の確定後に届いた保存も拒否される
        await begin(job.client, "service");
        const lateOutcome = await within(track(recordSql(job.client, txnId, 103)).outcome, "late record_ai_decision");
        expect(lateOutcome.ok).toBe(false);
        if (!lateOutcome.ok) expect(lateOutcome.error.message).toMatch(NOT_WAITING);
        await rollbackQuietly(job.client);

        // 状態は保留のまま、保留の理由と確認ログは1行、判断ログは1行（置き換えも追加もされていない）
        expect(await statusOf(admin, txnId)).toBe("on_hold");
        const decisions = await decisionsOf(admin, txnId);
        expect(decisions).toHaveLength(1);
        expect(decisions[0]).toMatchObject({ id: decisionId, proposal: { account_item_id: 101 } });
        const reviews = async () =>
          (
            await admin.client.query<{ id: string; action: string; reason: string; reviewer_id: string; bulk: boolean }>(
              "select id, action, reason, reviewer_id, bulk from public.human_reviews where ai_decision_id = $1 order by created_at, id",
              [decisionId],
            )
          ).rows;
        const expectedReviews = [{ id: holdId, action: "hold", reason: HOLD_REASON, reviewer_id: STAFF_ID, bulk: false }];
        expect(await reviews()).toEqual(expectedReviews);

        // 確信度「高」でも、保留中の明細は管理者でもまとめて承認できない
        await begin(admin.client, "admin");
        try {
          await admin.client.query("savepoint bulk");
          await expect(admin.client.query("select public.record_human_review($1, 'approve', null, null, 1, true)", [decisionId])).rejects.toThrow(
            /保留中の明細はまとめて承認できません/,
          );
          await admin.client.query("rollback to savepoint bulk");
        } finally {
          await rollbackQuietly(admin.client);
        }
        expect(await statusOf(admin, txnId)).toBe("on_hold");
        expect(await reviews()).toEqual(expectedReviews);

        // 監査記録は追記専用のまま（更新・削除は拒否される）
        for (const sql of [
          "update public.human_reviews set reason = 'changed'",
          "delete from public.human_reviews",
          "update public.ai_decisions set confidence = 'low'",
          "delete from public.ai_decisions",
        ]) {
          await admin.client.query("begin");
          try {
            await expect(admin.client.query(sql)).rejects.toThrow(/append-only/);
          } finally {
            await rollbackQuietly(admin.client);
          }
        }
        expect(await reviews()).toEqual(expectedReviews);
        expect(await decisionsOf(admin, txnId)).toEqual(decisions);
      });
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------------------------
// ルール・メモの作成（親 + 版1）と、版の追加

type Variant = "A" | "B";

/** ルールとメモで共通の競合シナリオを流すための定義 */
type VersionedKind = {
  label: string;
  /** 親と版1を作る関数の呼出し。variant ごとに内容が違う */
  create: (client: Client, id: string, variant: Variant) => Promise<unknown>;
  /** 版 version を直接追加する（アプリが「現在の版 N + 1」を計算して入れる想定の INSERT） */
  addVersion: (client: Client, id: string, version: number, variant: Variant) => Promise<unknown>;
  currentVersion: (client: Client, id: string) => Promise<number>;
  /** 親の行と版の内容（ID 指定。created_at は除く） */
  contents: (admin: Session, id: string) => Promise<{ parents: string[]; versions: Record<string, unknown>[] }>;
  /** 親・版の全テーブルの全行（履歴が変わっていないことの確認用） */
  everything: (admin: Session) => Promise<string[]>;
};

const KINDS: VersionedKind[] = [
  {
    label: "create_rule_from_past_candidate",
    create: (client, id, variant) =>
      client.query("select public.create_rule_from_past_candidate($1, $2, 'サンプルツウシン', 'expense', 101, $3, $4)", [
        CUSTOMER_A,
        id,
        variant === "A" ? 21 : 2,
        variant === "A" ? 50 : 7,
      ]),
    addVersion: (client, id, version, variant) =>
      client.query(
        `insert into public.journal_rule_versions (rule_id, version, customer_id, priority, status, source, cond_partner_key, cond_direction, account_item_id, tax_code, created_by)
         values ($1, $2, $3, $4, 'proposed', 'staff', 'サンプルツウシン', 'expense', 101, 21, $5)`,
        [id, version, CUSTOMER_A, variant === "A" ? 61 : 62, STAFF_ID],
      ),
    currentVersion: async (client, id) =>
      Number((await client.query<{ v: number }>("select max(version) as v from public.journal_rule_versions where rule_id = $1", [id])).rows[0]!.v),
    contents: async (admin, id) => ({
      parents: (await admin.client.query<{ id: string }>("select id from public.journal_rules where id = $1", [id])).rows.map((r) => r.id),
      versions: (
        await admin.client.query(
          "select version, priority, status, source, tax_code, account_item_id::text as account_item_id, cond_partner_key, created_by from public.journal_rule_versions where rule_id = $1 order by version",
          [id],
        )
      ).rows,
    }),
    everything: async (admin) =>
      (
        await admin.client.query<{ r: string }>(
          `select to_jsonb(p)::text as r from public.journal_rules p
           union all select to_jsonb(v)::text from public.journal_rule_versions v`,
        )
      ).rows.map((x) => x.r),
  },
  {
    label: "create_customer_note",
    create: (client, id, variant) => client.query("select public.create_customer_note($1, $2, $3, $4)", [CUSTOMER_A, id, `同時作成${variant}`, `本文${variant}`]),
    addVersion: (client, id, version, variant) =>
      client.query(
        `insert into public.customer_note_versions (note_id, version, customer_id, status, title, body, created_by)
         values ($1, $2, $3, 'inactive', $4, $5, $6)`,
        [id, version, CUSTOMER_A, `改訂${variant}`, `改訂本文${variant}`, STAFF_ID],
      ),
    currentVersion: async (client, id) =>
      Number((await client.query<{ v: number }>("select max(version) as v from public.customer_note_versions where note_id = $1", [id])).rows[0]!.v),
    contents: async (admin, id) => ({
      parents: (await admin.client.query<{ id: string }>("select id from public.customer_notes where id = $1", [id])).rows.map((r) => r.id),
      versions: (
        await admin.client.query("select version, status, title, body, created_by from public.customer_note_versions where note_id = $1 order by version", [id])
      ).rows,
    }),
    everything: async (admin) =>
      (
        await admin.client.query<{ r: string }>(
          `select to_jsonb(p)::text as r from public.customer_notes p
           union all select to_jsonb(v)::text from public.customer_note_versions v`,
        )
      ).rows.map((x) => x.r),
  },
];

/** 変更前の行がすべて残り、増えた行数が想定どおりであること（既存の履歴を書き換えていない） */
function expectOnlyAdded(before: string[], after: string[], added: number) {
  const kept = new Set(after);
  expect(before.filter((r) => !kept.has(r)), "既存の行が変わった・消えた").toEqual([]);
  expect(after.length - before.length).toBe(added);
}

const UNIQUE_VIOLATION = "23505";

describe.each(KINDS)("同時の作成と版の追加（2セッション）: $label", (kind) => {
  it(
    "同じ依頼IDは、先の確定を待たされた後に 23505 で拒否され、先の内容を上書きしない（親1・版1）",
    async () => {
      const id = randomUUID();
      await withSessions(async (admin, open) => {
        const a = await open("conc-create-a");
        const b = await open("conc-create-b");
        const before = await kind.everything(admin);

        await begin(a.client, "staff");
        await kind.create(a.client, id, "A"); // 未確定のまま保持
        expect(await sessionState(admin, a)).toBe("idle in transaction");

        await begin(b.client, "staff");
        const second = track(kind.create(b.client, id, "B"));
        expect(["transactionid", "tuple"]).toContain(await waitUntilBlocked(admin, b, a, second, "同じ依頼IDの2つ目"));

        await commit(a.client);
        const outcome = await within(second.outcome, "second create");
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect((outcome.error as Error & { code?: string }).code).toBe(UNIQUE_VIOLATION);
        await rollbackQuietly(b.client);

        const contents = await kind.contents(admin, id);
        expect(contents.parents).toEqual([id]);
        expect(contents.versions).toHaveLength(1);
        expect(contents.versions[0]).toMatchObject({ version: 1, created_by: STAFF_ID });
        const winner = contents.versions[0]!;
        // 先の内容（A）のまま。後の内容（B）は入っていない
        expect(JSON.stringify(winner)).not.toMatch(/同時作成B|本文B|"priority":7/);
        expectOnlyAdded(before, await kind.everything(admin), 2);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "先のセッションがロールバックすると、待っていた同じ依頼IDの作成が成功する（先の内容は残らない）",
    async () => {
      const id = randomUUID();
      await withSessions(async (admin, open) => {
        const a = await open("conc-rollback-a");
        const b = await open("conc-rollback-b");
        const before = await kind.everything(admin);

        await begin(a.client, "staff");
        await kind.create(a.client, id, "A");

        await begin(b.client, "staff");
        const second = track(kind.create(b.client, id, "B"));
        expect(["transactionid", "tuple"]).toContain(await waitUntilBlocked(admin, b, a, second, "ロールバックを待つ作成"));

        await rollbackQuietly(a.client);
        const outcome = await within(second.outcome, "successor create");
        if (!outcome.ok) throw outcome.error;
        await commit(b.client);

        const contents = await kind.contents(admin, id);
        expect(contents.parents).toEqual([id]);
        expect(contents.versions).toHaveLength(1);
        // 後続（B）の内容だけが残り、ロールバックした A の内容は残らない
        expect(JSON.stringify(contents.versions[0])).toMatch(kind.label === "create_customer_note" ? /同時作成B/ : /"priority":7/);
        expect(JSON.stringify(contents.versions[0])).not.toMatch(/同時作成A|本文A|"priority":50/);
        expectOnlyAdded(before, await kind.everything(admin), 2);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "別々の依頼IDは互いに待たず、どちらも確定でき、それぞれ親1・版1になる",
    async () => {
      const idA = randomUUID();
      const idB = randomUUID();
      await withSessions(async (admin, open) => {
        const a = await open("conc-distinct-a");
        const b = await open("conc-distinct-b");
        const before = await kind.everything(admin);

        await begin(a.client, "staff");
        await kind.create(a.client, idA, "A"); // 未確定のまま保持
        await begin(b.client, "staff");
        // A が未確定のままでも、B は待たずに完了する（完了しなければタイムアウトで失敗する）
        const outcome = await within(track(kind.create(b.client, idB, "B")).outcome, "distinct create");
        if (!outcome.ok) throw outcome.error;
        expect(await sessionState(admin, a)).toBe("idle in transaction");

        await commit(a.client);
        await commit(b.client);

        for (const id of [idA, idB]) {
          const contents = await kind.contents(admin, id);
          expect(contents.parents).toEqual([id]);
          expect(contents.versions).toHaveLength(1);
        }
        expectOnlyAdded(before, await kind.everything(admin), 4);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "同じ現在の版 N を読んだ2つの「版 N+1」の追加は、後の追加が待たされた後に 23505 で拒否され、先の版だけが残る",
    async () => {
      const id = randomUUID();
      await withSessions(async (admin, open) => {
        const setup = await open("conc-version-setup");
        await inTx(setup.client, "staff", () => kind.create(setup.client, id, "A"));
        const a = await open("conc-version-a");
        const b = await open("conc-version-b");
        const before = await kind.everything(admin);
        const baseContents = await kind.contents(admin, id);

        await begin(a.client, "staff");
        await begin(b.client, "staff");
        // 両方が同じ現在の版を読む
        const nA = await kind.currentVersion(a.client, id);
        const nB = await kind.currentVersion(b.client, id);
        expect([nA, nB]).toEqual([1, 1]);

        await kind.addVersion(a.client, id, nA + 1, "A"); // 未確定のまま保持
        const second = track(kind.addVersion(b.client, id, nB + 1, "B"));
        expect(["transactionid", "tuple"]).toContain(await waitUntilBlocked(admin, b, a, second, "同じ版 N+1 の2つ目"));

        await commit(a.client);
        const outcome = await within(second.outcome, "second addVersion");
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect((outcome.error as Error & { code?: string }).code).toBe(UNIQUE_VIOLATION);
        await rollbackQuietly(b.client);

        const contents = await kind.contents(admin, id);
        expect(contents.parents).toEqual([id]);
        expect(contents.versions).toHaveLength(2);
        expect(contents.versions[0]).toEqual(baseContents.versions[0]); // 版1は変わらない
        expect(contents.versions[1]).toMatchObject({ version: 2, created_by: STAFF_ID });
        expect(JSON.stringify(contents.versions[1])).not.toMatch(/改訂B|改訂本文B|"priority":62/); // 先の追加（A）の内容だけ
        expectOnlyAdded(before, await kind.everything(admin), 1);
      });
    },
    TEST_TIMEOUT_MS,
  );
});
