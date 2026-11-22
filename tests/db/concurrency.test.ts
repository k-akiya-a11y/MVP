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
// 取込の再試行・並行の回帰（docs/reviews/2026-11-05-import-retry-concurrency.md）

async function importsOf(admin: Session, fileLike: string) {
  const res = await admin.client.query<{
    id: string;
    file_name: string;
    status: string;
    row_count: number;
    inserted_count: number;
    skipped_duplicate_count: number;
    suspected_duplicate_count: number;
    income_total: string;
    expense_total: string;
    inserted_amount_total: string;
    skipped_amount_total: string;
    suspected_amount_total: string;
    batch_hash: string;
  }>(
    `select id, file_name, status, row_count, inserted_count, skipped_duplicate_count, suspected_duplicate_count,
            income_total, expense_total, inserted_amount_total, skipped_amount_total, suspected_amount_total, batch_hash
     from public.statement_imports where file_name like $1 order by imported_at, id`,
    [fileLike],
  );
  return res.rows;
}

const sumAmounts = (txns: { amount: string }[]) => txns.reduce((sum, t) => sum + Number(t.amount), 0);

describe("取込の再試行・並行の回帰（2セッション）", () => {
  it(
    "確定済みの取込の応答を失った（模擬）後、別セッションからの再試行は明細を増やさず、元の明細・件数・金額のまま再実行として読み飛ばす",
    async () => {
      // 注意: 「応答の消失」は、返り値を使わず元の接続を閉じることによる模擬である。実際の HTTP・ブラウザ・ネットワーク断の再現ではない
      const tag = uniqueTag();
      const file = `${tag}-upload.csv`;
      const rows: ImportRow[] = [
        { txn_date: "2026-10-27", amount: 9020, direction: "expense", description: "SAMPLE TELECOM", balance: 90980, dedupe_key: `${tag}-r1` },
        { txn_date: "2026-10-31", amount: 330000, direction: "income", description: "SAMPLE CLIENT", balance: 420980, dedupe_key: `${tag}-r2` },
      ];
      await withSessions(async (admin, open) => {
        const original = await open("conc-lost-original");
        await inTx(original.client, "staff", () => importSql(original.client, file, rows)); // 返り値は捨てる（消失した応答）
        await original.client.end(); // 元の接続も閉じる

        // 元の取込は確定している（応答を見ていなくても、DB には残っている）。ID は応答ではなく DB から読む
        const beforeTxns = await txnsOf(admin, tag);
        const beforeImports = await importsOf(admin, file);
        expect(beforeTxns.map((t) => t.dedupe_key)).toEqual([`${tag}-r1`, `${tag}-r2`]);
        expect(beforeImports).toHaveLength(1);
        const originalImport = beforeImports[0]!;
        expect(originalImport).toMatchObject({ status: "completed", row_count: 2, inserted_count: 2, skipped_duplicate_count: 0, suspected_duplicate_count: 0 });
        expect(beforeTxns.every((t) => t.status === "new" && t.import_id === originalImport.id)).toBe(true);

        // 独立した新しいセッションからの再試行
        const retry = await open("conc-lost-retry");
        const result = (await inTx(retry.client, "staff", () => importSql(retry.client, file, rows))).rows[0]!;
        expect(result.import_id).not.toBe(originalImport.id);
        expect(result).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 2, suspected_duplicate_count: 0 });
        expect(Number(result.income_total)).toBe(330000);
        expect(Number(result.expense_total)).toBe(9020);
        expect(Number(result.inserted_amount_total)).toBe(0);
        expect(Number(result.skipped_amount_total)).toBe(330000 + 9020);
        expect(Number(result.suspected_amount_total)).toBe(0);

        // 明細は元のまま（ID・取込ID・キー・状態・金額が完全に同じ）。再試行の取込IDを持つ明細はない
        const afterTxns = await txnsOf(admin, tag);
        expect(afterTxns).toEqual(beforeTxns);
        expect(afterTxns.some((t) => t.import_id === result.import_id)).toBe(false);
        expect(sumAmounts(afterTxns)).toBe(330000 + 9020);

        // 取込記録は元と再試行の2件。元の記録は変わらず、同じ内容のハッシュ、各記録で 読めた行 = 登録 + 読み飛ばし + 重複の疑い
        const afterImports = await importsOf(admin, file);
        expect(afterImports).toHaveLength(2);
        expect(afterImports.find((i) => i.id === originalImport.id)).toEqual(originalImport);
        const retried = afterImports.find((i) => i.id === result.import_id)!;
        expect(retried).toMatchObject({ status: "completed", row_count: 2, inserted_count: 0, skipped_duplicate_count: 2, suspected_duplicate_count: 0 });
        expect(retried.batch_hash).toBe(originalImport.batch_hash);
        for (const rec of afterImports) {
          expect(rec.inserted_count + rec.skipped_duplicate_count + rec.suspected_duplicate_count).toBe(rec.row_count);
        }
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "先の取込がロールバックすると、顧客単位のロックを待っていた同じ内容の取込が1回だけ登録され、取り消された取込・明細・記録は残らず、金額が合う",
    async () => {
      const tag = uniqueTag();
      const file = `${tag}-upload.csv`;
      const rows: ImportRow[] = [
        { txn_date: "2026-10-27", amount: 9020, direction: "expense", description: "SAMPLE TELECOM", balance: 90980, dedupe_key: `${tag}-b1` },
        { txn_date: "2026-10-31", amount: 330000, direction: "income", description: "SAMPLE CLIENT", balance: 420980, dedupe_key: `${tag}-b2` },
      ];
      await withSessions(async (admin, open) => {
        const a = await open("conc-abort-a");
        const b = await open("conc-abort-b");

        await begin(a.client, "staff");
        const aborted = (await importSql(a.client, file, rows)).rows[0]!; // 未確定のまま保持
        expect(aborted.inserted_count).toBe(2);

        await begin(b.client, "staff");
        const second = track(importSql(b.client, file, rows));
        expect(await waitUntilBlocked(admin, b, a, second, "同じ内容の取込（先がロールバックする）")).toBe("advisory");

        await rollbackQuietly(a.client);
        const outcome = await within(second.outcome, "waiting import after rollback");
        if (!outcome.ok) throw outcome.error;
        await commit(b.client);

        const result = outcome.value.rows[0]!;
        expect(result.import_id).not.toBe(aborted.import_id);
        expect(result).toMatchObject({ inserted_count: 2, skipped_duplicate_count: 0, suspected_duplicate_count: 0 });
        expect(Number(result.inserted_amount_total)).toBe(330000 + 9020);
        expect(Number(result.skipped_amount_total)).toBe(0);
        expect(Number(result.suspected_amount_total)).toBe(0);

        // 明細は待っていた取込の2件だけ（1回だけ登録）。金額 = 入金 + 出金 = 登録金額
        const txns = await txnsOf(admin, tag);
        expect(txns.map((t) => t.dedupe_key)).toEqual([`${tag}-b1`, `${tag}-b2`]);
        expect(txns.every((t) => t.status === "new" && t.import_id === result.import_id && t.duplicate_of_id === null)).toBe(true);
        expect(sumAmounts(txns)).toBe(Number(result.income_total) + Number(result.expense_total));
        expect(sumAmounts(txns)).toBe(Number(result.inserted_amount_total));

        // 取り消された取込の記録・明細は残っていない。この内容の取込記録は待っていた取込の1件だけ
        const abortedRecord = await admin.client.query("select 1 from public.statement_imports where id = $1", [aborted.import_id]);
        expect(abortedRecord.rowCount).toBe(0);
        const abortedTxns = await admin.client.query("select 1 from public.bank_transactions where import_id = $1", [aborted.import_id]);
        expect(abortedTxns.rowCount).toBe(0);
        const imports = await importsOf(admin, file);
        expect(imports.map((i) => i.id)).toEqual([result.import_id]);
        expect(imports[0]!.inserted_count + imports[0]!.skipped_duplicate_count + imports[0]!.suspected_duplicate_count).toBe(imports[0]!.row_count);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "残高のない同一内容の取込が同時に来ても、直列化され、後の取込は読み飛ばさず・通常の新規にもせず、元の明細を指す「重複の疑い」として残し、件数・金額が合う",
    async () => {
      const tag = uniqueTag();
      const file = `${tag}-upload.csv`;
      const rows: ImportRow[] = [
        { txn_date: "2026-10-27", amount: 1200, direction: "expense", description: "SAMPLE STATIONERY", balance: null, dedupe_key: `${tag}-n1` },
        { txn_date: "2026-10-28", amount: 5000, direction: "income", description: "SAMPLE REFUND", balance: null, dedupe_key: `${tag}-n2` },
      ];
      await withSessions(async (admin, open) => {
        const a = await open("conc-nobalance-a");
        const b = await open("conc-nobalance-b");

        await begin(a.client, "staff");
        const first = (await importSql(a.client, file, rows)).rows[0]!; // 未確定のまま保持
        expect(first).toMatchObject({ inserted_count: 2, skipped_duplicate_count: 0, suspected_duplicate_count: 0 });

        await begin(b.client, "staff");
        const second = track(importSql(b.client, file, rows));
        // 直列化: 後の取込は先の確定まで完了しない
        expect(await waitUntilBlocked(admin, b, a, second, "残高なしの同一取込")).toBe("advisory");

        await commit(a.client);
        const outcome = await within(second.outcome, "second no-balance import");
        if (!outcome.ok) throw outcome.error;
        await commit(b.client);

        const result = outcome.value.rows[0]!;
        expect(result.import_id).not.toBe(first.import_id);
        expect(result).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 0, suspected_duplicate_count: 2 });
        expect(Number(result.income_total)).toBe(5000);
        expect(Number(result.expense_total)).toBe(1200);
        expect(Number(result.inserted_amount_total)).toBe(0);
        expect(Number(result.skipped_amount_total)).toBe(0);
        expect(Number(result.suspected_amount_total)).toBe(1200 + 5000);

        // 明細は4件: 元の2件（new）と、後の取込の「重複の疑い」2件（元の明細を指す）。黙って捨てていない
        const txns = await txnsOf(admin, tag);
        expect(txns).toHaveLength(4);
        expect(sumAmounts(txns)).toBe(2 * (1200 + 5000));
        const originals = txns.filter((t) => t.import_id === first.import_id);
        const suspected = txns.filter((t) => t.import_id === result.import_id);
        expect(originals.map((t) => t.dedupe_key)).toEqual([`${tag}-n1`, `${tag}-n2`]);
        expect(originals.every((t) => t.status === "new" && t.duplicate_of_id === null)).toBe(true);
        // 通常の新規明細として増えていない（後の取込の明細はすべて重複の疑い）
        expect(txns.filter((t) => t.status === "new")).toHaveLength(2);
        expect(suspected).toHaveLength(2);
        for (const s of suspected) {
          const key = s.dedupe_key.replace(`:suspected:${result.import_id}`, "");
          const original = originals.find((o) => o.dedupe_key === key);
          expect(original, `${s.dedupe_key} の元の明細`).toBeDefined();
          expect(s).toMatchObject({ status: "duplicate_suspected", duplicate_of_id: original!.id });
          expect(s.amount).toBe(original!.amount);
        }

        // 取込記録は2件。各記録で 読めた行 = 登録 + 読み飛ばし + 重複の疑い（件数・金額とも）
        const imports = await importsOf(admin, file);
        expect(imports.map((i) => i.id)).toEqual([first.import_id, result.import_id]);
        expect(imports[0]).toMatchObject({ row_count: 2, inserted_count: 2, skipped_duplicate_count: 0, suspected_duplicate_count: 0 });
        expect(imports[1]).toMatchObject({ row_count: 2, inserted_count: 0, skipped_duplicate_count: 0, suspected_duplicate_count: 2 });
        expect(imports[0]!.batch_hash).toBe(imports[1]!.batch_hash);
        for (const rec of imports) {
          expect(rec.inserted_count + rec.skipped_duplicate_count + rec.suspected_duplicate_count).toBe(rec.row_count);
          expect(Number(rec.inserted_amount_total) + Number(rec.skipped_amount_total) + Number(rec.suspected_amount_total)).toBe(
            Number(rec.income_total) + Number(rec.expense_total),
          );
        }
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
// 保留の重複防止（別タブ・別端末の模擬）（docs/reviews/2026-11-05-review-cross-tab.md）

const ALREADY_ON_HOLD = /すでに保留/;
const HOLD_SECONDS = 45;
/** どの顧客にも割り当てのない担当者（合成）。seed の担当者はサンプル商事だけを担当する */
const UNASSIGNED_STAFF_ID = "00000000-0000-4000-8000-0000000000a3";

const holdSql = (client: Client, decisionId: string, seconds = HOLD_SECONDS) =>
  client.query<{ id: string }>("select public.record_human_review($1, 'hold', null, $2, $3, false) as id", [decisionId, HOLD_REASON, seconds]);

/** 候補作成済（proposed）の明細と、その判断ログを確定済みの状態で作る */
async function createProposed(admin: Session, open: (label: string) => Promise<Session>, tag: string) {
  const txnId = await createNewTxn(admin, tag);
  const setup = await open(`conc-dup-setup-${tag}`);
  const decisionId = await inTx(setup.client, "service", async () => (await recordSql(setup.client, txnId, 101)).rows[0]!.id);
  expect(await statusOf(admin, txnId)).toBe("proposed");
  return { txnId, decisionId };
}

async function reviewRowsOf(admin: Session, decisionId: string) {
  return (
    await admin.client.query<{ id: string; action: string; reason: string | null; reviewer_id: string; review_seconds: number; bulk: boolean }>(
      "select id, action, reason, reviewer_id, review_seconds, bulk from public.human_reviews where ai_decision_id = $1 order by created_at, id",
      [decisionId],
    )
  ).rows;
}

async function pastEntryCount(admin: Session, decisionId: string): Promise<number> {
  return Number((await admin.client.query<{ n: string }>("select count(*) as n from public.past_journal_entries where ai_decision_id = $1", [decisionId])).rows[0]!.n);
}

const totalSeconds = (rows: { review_seconds: number }[]) => rows.reduce((sum, r) => sum + r.review_seconds, 0);

/** 割り当てのない担当者を作る（使い捨て DB。自動コミットの admin セッションで作成） */
async function ensureUnassignedStaff(admin: Session): Promise<void> {
  await admin.client.query("insert into auth.users (id, email) values ($1, 'unassigned@example.com') on conflict (id) do nothing", [UNASSIGNED_STAFF_ID]);
  await admin.client.query(
    "insert into public.staff_members (user_id, email, display_name, role) values ($1, 'unassigned@example.com', '割当なし担当者（合成）', 'staff') on conflict (user_id) do nothing",
    [UNASSIGNED_STAFF_ID],
  );
}

async function beginAsUser(client: Client, userId: string): Promise<void> {
  await client.query("begin");
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
  await client.query("set local role authenticated");
}

describe("保留の重複防止（別タブ・別端末の模擬、2セッション）", () => {
  it(
    "すでに保留中の候補への2回目の保留は、担当者・管理者のどちらでも拒否され、確認ログ・確認時間・状態・過去仕訳を変えない（順次）",
    async () => {
      const tag = uniqueTag();
      await withSessions(async (admin, open) => {
        const { txnId, decisionId } = await createProposed(admin, open, tag);
        const tab1 = await open("conc-dup-seq-tab1");
        const tab2 = await open("conc-dup-seq-tab2");
        const approver = await open("conc-dup-seq-admin");

        const firstId = await inTx(tab1.client, "staff", async () => (await holdSql(tab1.client, decisionId)).rows[0]!.id);
        expect(await statusOf(admin, txnId)).toBe("on_hold");
        const afterFirst = await reviewRowsOf(admin, decisionId);
        expect(afterFirst).toEqual([{ id: firstId, action: "hold", reason: HOLD_REASON, reviewer_id: STAFF_ID, review_seconds: HOLD_SECONDS, bulk: false }]);

        // 古い画面（別タブ）から、同じ候補への保留がもう一度届く
        await expect(inTx(tab2.client, "staff", () => holdSql(tab2.client, decisionId))).rejects.toThrow(ALREADY_ON_HOLD);
        // 管理者の保留も同じ（保留中の候補を、重ねて保留にしない）
        await expect(inTx(approver.client, "admin", () => holdSql(approver.client, decisionId))).rejects.toThrow(ALREADY_ON_HOLD);

        // 確認ログは最初の1行のまま（同じ ID・内容）、確認時間は1回分、状態は保留のまま、過去仕訳は作られない
        expect(await reviewRowsOf(admin, decisionId)).toEqual(afterFirst);
        expect(totalSeconds(await reviewRowsOf(admin, decisionId))).toBe(HOLD_SECONDS);
        expect(await statusOf(admin, txnId)).toBe("on_hold");
        expect(await pastEntryCount(admin, decisionId)).toBe(0);
        expect(await decisionsOf(admin, txnId)).toHaveLength(1);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "先の保留が未確定の間に来た同じ候補への保留は、ロック待ちのあと拒否され、保留の確認ログと確認時間が1回分だけ残る（観測した2セッションの重なり）",
    async () => {
      const tag = uniqueTag();
      await withSessions(async (admin, open) => {
        const { txnId, decisionId } = await createProposed(admin, open, tag);
        const a = await open("conc-dup-tab-a");
        const b = await open("conc-dup-tab-b");

        // タブ A の保留（未確定のまま保持）
        await begin(a.client, "staff");
        const firstId = (await holdSql(a.client, decisionId)).rows[0]!.id;
        expect(await sessionState(admin, a)).toBe("idle in transaction");

        // タブ B も、同じ「候補作成済」の候補への保留を送る。A の確定までロック待ちになることを観測する
        await begin(b.client, "staff");
        const second = track(holdSql(b.client, decisionId));
        expect(["transactionid", "tuple"]).toContain(await waitUntilBlocked(admin, b, a, second, "別タブの同時の保留"));

        await commit(a.client);
        const outcome = await within(second.outcome, "second hold");
        expect(outcome.ok, "後の保留は、先の確定後に拒否される").toBe(false);
        if (outcome.ok) return;
        expect(outcome.error.message).toMatch(ALREADY_ON_HOLD);
        await rollbackQuietly(b.client);

        const reviews = await reviewRowsOf(admin, decisionId);
        expect(reviews).toEqual([{ id: firstId, action: "hold", reason: HOLD_REASON, reviewer_id: STAFF_ID, review_seconds: HOLD_SECONDS, bulk: false }]);
        expect(totalSeconds(reviews)).toBe(HOLD_SECONDS);
        expect(await statusOf(admin, txnId)).toBe("on_hold");
        expect(await pastEntryCount(admin, decisionId)).toBe(0);
        expect(await decisionsOf(admin, txnId)).toHaveLength(1);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "保留が拒否されたあとの再試行（確認時間を変えて）も拒否され、確認時間を増やさない",
    async () => {
      const tag = uniqueTag();
      await withSessions(async (admin, open) => {
        const { txnId, decisionId } = await createProposed(admin, open, tag);
        const tab = await open("conc-dup-retry");

        await inTx(tab.client, "staff", () => holdSql(tab.client, decisionId));
        const afterFirst = await reviewRowsOf(admin, decisionId);
        expect(totalSeconds(afterFirst)).toBe(HOLD_SECONDS);

        // 拒否される保留を、確認時間を変えて繰り返し送っても、記録は増えない
        for (const seconds of [HOLD_SECONDS, 30, 0]) {
          await expect(inTx(tab.client, "staff", () => holdSql(tab.client, decisionId, seconds))).rejects.toThrow(ALREADY_ON_HOLD);
        }

        expect(await reviewRowsOf(admin, decisionId)).toEqual(afterFirst);
        expect(totalSeconds(await reviewRowsOf(admin, decisionId))).toBe(HOLD_SECONDS);
        expect(await statusOf(admin, txnId)).toBe("on_hold");
        expect(await pastEntryCount(admin, decisionId)).toBe(0);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    { action: "approve" as const, finalEntry: null, status: "approved", pastEntries: 1 },
    { action: "correct" as const, finalEntry: { account_item_id: 102, tax_code: 21 }, status: "approved", pastEntries: 1 },
    { action: "reject" as const, finalEntry: null, status: "rejected", pastEntries: 0 },
  ])(
    "保留中の候補を管理者が $action で確定できる（保留はあとの確定をふさがず、保留の行は変わらない）",
    async ({ action, finalEntry, status, pastEntries }) => {
      const tag = uniqueTag();
      await withSessions(async (admin, open) => {
        const { txnId, decisionId } = await createProposed(admin, open, tag);
        const tab = await open("conc-dup-release-staff");
        const approver = await open("conc-dup-release-admin");

        await inTx(tab.client, "staff", () => holdSql(tab.client, decisionId));
        const heldRows = await reviewRowsOf(admin, decisionId);
        expect(heldRows).toHaveLength(1);
        expect(await statusOf(admin, txnId)).toBe("on_hold");

        const resolvedId = await inTx(approver.client, "admin", async () =>
          (
            await approver.client.query<{ id: string }>("select public.record_human_review($1, $2, $3::jsonb, null, 20, false) as id", [
              decisionId,
              action,
              finalEntry === null ? null : JSON.stringify(finalEntry),
            ])
          ).rows[0]!.id,
        );

        // 保留の行はそのまま、確定の行が1行追加される。確認時間は 保留 + 確定
        const reviews = await reviewRowsOf(admin, decisionId);
        expect(reviews).toHaveLength(2);
        expect(reviews[0]).toEqual(heldRows[0]);
        expect(reviews[1]).toMatchObject({ id: resolvedId, action, reviewer_id: ADMIN_ID, review_seconds: 20 });
        expect(totalSeconds(reviews)).toBe(HOLD_SECONDS + 20);
        expect(await statusOf(admin, txnId)).toBe(status);
        expect(await pastEntryCount(admin, decisionId)).toBe(pastEntries);

        // 確定後に、もう一度保留しても確認済みとして拒否され、何も増えない
        await expect(inTx(tab.client, "staff", () => holdSql(tab.client, decisionId))).rejects.toThrow(/すでに確認済み/);
        expect(await reviewRowsOf(admin, decisionId)).toEqual(reviews);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "担当外の担当者は、候補作成済でも保留中でも保留・承認できず、状態を漏らす文言も返さず、確認ログと状態を変えない",
    async () => {
      const tag = uniqueTag();
      await withSessions(async (admin, open) => {
        await ensureUnassignedStaff(admin);
        const proposed = await createProposed(admin, open, `${tag}p`);
        const held = await createProposed(admin, open, `${tag}h`);
        const owner = await open("conc-dup-auth-owner");
        const outsider = await open("conc-dup-auth-outsider");

        await inTx(owner.client, "staff", () => holdSql(owner.client, held.decisionId));
        const heldRows = await reviewRowsOf(admin, held.decisionId);
        expect(heldRows).toHaveLength(1);

        for (const target of [proposed, held]) {
          for (const sql of [
            "select public.record_human_review($1, 'hold', null, '担当外からの保留', 10, false)",
            "select public.record_human_review($1, 'approve', null, null, 10, false)",
          ]) {
            await beginAsUser(outsider.client, UNASSIGNED_STAFF_ID);
            try {
              const err = await outsider.client.query(sql, [target.decisionId]).then(
                () => undefined,
                (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
              );
              expect(err, `担当外の呼出しは拒否される: ${sql}`).toBeDefined();
              expect(err!.message).toMatch(/仕訳候補が見つかりません/);
              expect(err!.message).not.toMatch(ALREADY_ON_HOLD);
            } finally {
              await rollbackQuietly(outsider.client);
            }
          }
        }

        // 候補作成済の明細は、確認ログなし・proposed のまま。保留中の明細は、最初の1行のまま
        expect(await reviewRowsOf(admin, proposed.decisionId)).toEqual([]);
        expect(await statusOf(admin, proposed.txnId)).toBe("proposed");
        expect(await reviewRowsOf(admin, held.decisionId)).toEqual(heldRows);
        expect(await statusOf(admin, held.txnId)).toBe("on_hold");
        expect(await pastEntryCount(admin, proposed.decisionId)).toBe(0);
        expect(await pastEntryCount(admin, held.decisionId)).toBe(0);

        // 割り当てのある担当者は承認できない（管理者だけ）。承認の権限は広がっていない
        await beginAsUser(owner.client, STAFF_ID);
        try {
          const err = await owner.client.query("select public.record_human_review($1, 'approve', null, null, 10, false)", [held.decisionId]).then(
            () => undefined,
            (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
          );
          expect(err, "担当者の承認は拒否される").toBeDefined();
          expect(err!.message).toContain("承認・修正・却下は承認者（管理者）だけが行えます。保留にして理由を残してください");
        } finally {
          await rollbackQuietly(owner.client);
        }
        expect(await reviewRowsOf(admin, held.decisionId)).toEqual(heldRows);
        expect(await statusOf(admin, held.txnId)).toBe("on_hold");
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
