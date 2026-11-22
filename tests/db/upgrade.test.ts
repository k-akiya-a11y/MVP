import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyShim, createDisposableDatabase, noop, openClient, validateBaseUrl, type DisposableDatabase } from "./disposable-db";
import { ADMIN_ID, CUSTOMER_A, STAFF_ID, WALLET_A } from "./helpers";

/**
 * 既存データのある DB のアップグレード検証（development-rules.md「空 DB からの作成と、既存データのある DB からの
 * アップグレードの両方を検証」）。
 *
 * 固定のベースライン（下の BASELINE）の土台・マイグレーション・seed を git のオブジェクトから読み出して
 * 使い捨てデータベースに適用し、架空の既存データ（取込・明細・判断ログ・確認ログ・重複確認・ルール・メモ）を作る。
 * そのうえで 20261023000100〜20261105041046 だけを現在の作業ツリーから適用し、適用の前後でデータが変わらないことを比べる。
 * 20261024000100（仕訳候補ジョブの走査位置・貸出し）は内部の作業用の表を 2 つ加えるので、増えてよいのはその 2 表だけ
 * （位置は初期値の 1 行、貸出しは空）。既存の表の行は 1 行も変わらない。
 * 注意: このテストは書いただけで、まだどの DB にも実行していない（未実行）。
 *
 * - チェックアウトやリセットはしない（git show / git ls-tree で読むだけ）。履歴上のマイグレーションは書き換えない
 * - ベースラインのコミットが取得できなければ失敗する（スキップしない）。CI は fetch-depth: 0 で履歴を取得する
 * - 接続先は localhost の検証用サーバーだけ。共有の DB には触れず、専用の使い捨てデータベースを作って最後に削除する
 */

const BASELINE = "3908033eaeea30f85cec0f1325bd6adb003b43c2";
const BASELINE_LAST_MIGRATION = "20261022000100_import_wallet_kind_check.sql";
const UPGRADE_MIGRATIONS = [
  "20261023000100_import_batch_identity.sql",
  "20261023000200_record_ai_decision_only_new.sql",
  "20261023000300_create_rule_from_past_candidate.sql",
  "20261023000400_create_customer_note.sql",
  "20261024000100_proposal_scan_cursor.sql",
  "20261105041046_reject_duplicate_hold.sql",
];
/** アップグレードで新しく加わってよい内部の表（業務データではない作業用の状態）。これ以外の表は増えない */
const NEW_INTERNAL_TABLES = ["proposal_leases", "proposal_scan_cursor"];
/** アップグレードで新しく加わる関数（claim などはサービス専用） */
const NEW_FUNCTIONS = [
  "claim_pending_proposal_batch",
  "create_customer_note",
  "create_rule_from_past_candidate",
  "record_claimed_ai_decision",
  "release_proposal_claims",
  "renew_proposal_claim",
  "statement_batch_hash",
];
const DB_PREFIX = "mvp_upgrade_test_";

// 架空の固定 ID
const IMPORT_2 = "70000000-0000-4000-8000-000000000001";
const TXN_5 = "71000000-0000-4000-8000-000000000005";
const TXN_6 = "71000000-0000-4000-8000-000000000006";
const RULE_X = "72000000-0000-4000-8000-000000000001";
const NOTE_X = "73000000-0000-4000-8000-000000000001";
const NEW_RULE = "74000000-0000-4000-8000-000000000001";
const NEW_NOTE = "75000000-0000-4000-8000-000000000001";

// ---------------------------------------------------------------------------------------------
// git オブジェクトの読出し（読み取りだけ）

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new Error(
      `git ${args[0]} failed. The baseline commit ${BASELINE} must be available in this clone (CI: actions/checkout fetch-depth: 0; local: git fetch --unshallow). ${stderr}`.trim(),
    );
  }
}

const normalize = (text: string) => text.replace(/\r\n/g, "\n");
const baselineFile = (path: string) => git(["show", `${BASELINE}:${path}`]);
const baselineFiles = (dir: string) =>
  git(["ls-tree", "--name-only", BASELINE, `${dir}/`])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".sql"))
    .sort();

// ---------------------------------------------------------------------------------------------
// セッションの道具

type Actor = "staff" | "admin" | "service";

async function inTx<T>(client: Client, actor: Actor, fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    if (actor === "service") {
      await client.query("set local role service_role");
    } else {
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [actor === "staff" ? STAFF_ID : ADMIN_ID]);
      await client.query("set local role authenticated");
    }
    const result = await fn();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(noop);
    throw error;
  }
}

/** 失敗を期待する呼出し。エラーコードとメッセージを返す（トランザクションは取り消す） */
async function expectFailure(client: Client, actor: Actor, sql: string, params: unknown[]): Promise<{ code: string | undefined; message: string }> {
  try {
    await inTx(client, actor, () => client.query(sql, params));
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { code: e.code, message: e.message ?? "" };
  }
  throw new Error(`expected failure: ${sql}`);
}

type ImportRow = { txn_date: string; amount: number; direction: "income" | "expense"; description: string; balance: number | null; dedupe_key: string };
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

const importRows = (client: Client, file: string, rows: ImportRow[]) =>
  inTx(client, "staff", async () =>
    (
      await client.query<ImportResult>("select * from public.import_bank_statement($1, $2, 'csv', $3, 'bank_generic', $4, $5, '[]')", [
        CUSTOMER_A,
        WALLET_A,
        file,
        JSON.stringify(rows),
        rows.length,
      ])
    ).rows[0]!,
  );

const FIXTURE_ROWS: ImportRow[] = [
  { txn_date: "2026-10-27", amount: 9020, direction: "expense", description: "SAMPLE TELECOM", balance: 100000, dedupe_key: "upg-1" },
  { txn_date: "2026-10-31", amount: 330000, direction: "income", description: "SAMPLE CLIENT", balance: 430000, dedupe_key: "upg-2" },
  { txn_date: "2026-10-31", amount: 1000, direction: "expense", description: "SAMPLE SHOP", balance: null, dedupe_key: "upg-3" },
];

// ---------------------------------------------------------------------------------------------
// 前後の比較

/** public の全テーブルの全行（batch_hash 列は新しく加わる列なので除く）。テーブル名 → ソート済みの JSON 文字列 */
type Snapshot = Record<string, string[]>;

async function snapshot(client: Client): Promise<Snapshot> {
  const tables = await client.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name",
  );
  const result: Snapshot = {};
  for (const { table_name } of tables.rows) {
    const rows = await client.query<{ r: string }>(`select (to_jsonb(t) - 'batch_hash')::text as r from public.${client.escapeIdentifier(table_name)} t`);
    result[table_name] = rows.rows.map((x) => x.r).sort();
  }
  return result;
}

/** 金額・件数の集計（顧客 A）。ベースライン前後で同じ値でなければならない */
async function money(client: Client) {
  const txns = await client.query<{ status: string; direction: string; n: number; s: string }>(
    `select status, direction, count(*)::int as n, coalesce(sum(amount), 0)::text as s
     from public.bank_transactions where customer_id = $1 group by status, direction order by status, direction`,
    [CUSTOMER_A],
  );
  const imports = await client.query<{ n: number; row_count: string; inserted: string; skipped: string; suspected: string; income: string; expense: string }>(
    `select count(*)::int as n, coalesce(sum(row_count), 0)::text as row_count, coalesce(sum(inserted_count), 0)::text as inserted,
            coalesce(sum(skipped_duplicate_count), 0)::text as skipped, coalesce(sum(suspected_duplicate_count), 0)::text as suspected,
            coalesce(sum(income_total), 0)::text as income, coalesce(sum(expense_total), 0)::text as expense
     from public.statement_imports where customer_id = $1`,
    [CUSTOMER_A],
  );
  return { txns: txns.rows, imports: imports.rows[0] };
}

/** 適用後のスナップショットを、既存の表（ベースラインにもあった表）と、新しく加わった内部の表に分ける */
function splitInternal(after: Snapshot): { existing: Snapshot; added: Snapshot } {
  const existing: Snapshot = {};
  const added: Snapshot = {};
  for (const [table, rows] of Object.entries(after)) {
    if (NEW_INTERNAL_TABLES.includes(table)) added[table] = rows;
    else existing[table] = rows;
  }
  return { existing, added };
}

function expectBaselineRowsKept(before: Snapshot, after: Snapshot) {
  for (const [table, rows] of Object.entries(before)) {
    const kept = new Set(after[table]);
    const lost = rows.filter((r) => !kept.has(r));
    expect(lost, `${table}: 既存の行が変わった・消えた`).toEqual([]);
  }
}

function countDelta(before: Snapshot, after: Snapshot): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const table of Object.keys(before)) {
    const d = (after[table]?.length ?? 0) - before[table]!.length;
    if (d !== 0) delta[table] = d;
  }
  return delta;
}

// ---------------------------------------------------------------------------------------------

let db: DisposableDatabase | undefined;
let client: Client;
let before: Snapshot;
let beforeMoney: Awaited<ReturnType<typeof money>>;
let txnIds: Record<string, string> = {};
let fixtureImportId = "";
/** record_human_review の所有者・権限・security definer・search_path（アップグレードの前後で変わらないことを比べる） */
type FunctionShape = { owner: string; proacl: string | null; secdef: boolean; config: string[] | null; anon: boolean; auth: boolean; svc: boolean; public_exec: boolean; count: string };
let reviewFnBefore: FunctionShape;

const reviewFunctionShape = async (): Promise<FunctionShape> =>
  (
    await client.query<FunctionShape>(
      `select pg_get_userbyid(proowner) as owner, proacl::text as proacl, prosecdef as secdef, proconfig as config,
              has_function_privilege('anon', oid, 'execute') as anon,
              has_function_privilege('authenticated', oid, 'execute') as auth,
              has_function_privilege('service_role', oid, 'execute') as svc,
              exists (select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
              (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_human_review')::text as count
       from pg_proc where oid = 'public.record_human_review(uuid, text, jsonb, text, integer, boolean)'::regprocedure`,
    )
  ).rows[0]!;

beforeAll(async () => {
  const base = validateBaseUrl();

  // ベースラインが実在し、履歴上のマイグレーションが作業ツリーで書き換えられていないこと
  expect(git(["rev-parse", `${BASELINE}^{commit}`]).trim()).toBe(BASELINE);
  const baselineMigrations = baselineFiles("supabase/migrations");
  expect(baselineMigrations.length).toBeGreaterThan(0);
  expect(baselineMigrations[baselineMigrations.length - 1]).toBe(`supabase/migrations/${BASELINE_LAST_MIGRATION}`);
  for (const path of baselineMigrations) {
    expect(normalize(readFileSync(join(process.cwd(), path), "utf8")), `${path} はベースライン以降に書き換えない`).toBe(normalize(baselineFile(path)));
  }
  for (const name of UPGRADE_MIGRATIONS) {
    expect(baselineMigrations, `${name} はベースラインに含まれない`).not.toContain(`supabase/migrations/${name}`);
  }

  db = await createDisposableDatabase(base, DB_PREFIX);
  try {
    client = await openClient(db.url, "upgrade-test");

    // ベースラインの土台・マイグレーション・seed を、git のオブジェクトからそのまま適用する
    await applyShim(client, baselineFile("tests/db/supabase-shim.sql"));
    for (const path of baselineMigrations) await client.query(baselineFile(path));
    for (const path of baselineFiles("supabase/seed")) await client.query(baselineFile(path));

    await buildFixture();
    before = await snapshot(client);
    beforeMoney = await money(client);
    reviewFnBefore = await reviewFunctionShape();
  } catch (error) {
    await client?.end().catch(noop);
    await db.drop();
    throw error;
  }
}, 180_000);

afterAll(async () => {
  await client?.end().catch(noop);
  await db?.drop();
}, 60_000);

/** ベースラインの関数だけを使って、架空の既存データを作る（取込・判断ログ・確認ログ・重複確認・ルール・メモ） */
async function buildFixture() {
  // 取込 1: 3 件（入金 330,000 / 出金 9,020 + 1,000）
  const first = await importRows(client, "baseline-fixture.csv", FIXTURE_ROWS);
  fixtureImportId = first.import_id;
  expect(first).toMatchObject({ inserted_count: 3, skipped_duplicate_count: 0, suspected_duplicate_count: 0 });
  const ids = await client.query<{ id: string; dedupe_key: string }>("select id, dedupe_key from public.bank_transactions where dedupe_key like 'upg-%'");
  txnIds = Object.fromEntries(ids.rows.map((r) => [r.dedupe_key, r.id]));

  // 取込 2（重複の疑い 2 件。元の明細はそれぞれ upg-1 と upg-3）
  await client.query(
    `insert into public.statement_imports (id, customer_id, wallet_id, source, file_name, csv_format, row_count, suspected_duplicate_count,
       source_row_count, income_total, expense_total, suspected_amount_total)
     values ($1, $2, $3, 'csv', 'baseline-fixture-suspects.csv', 'bank_generic', 2, 2, 2, 0, 10020, 10020)`,
    [IMPORT_2, CUSTOMER_A, WALLET_A],
  );
  await client.query(
    `insert into public.bank_transactions (id, customer_id, wallet_id, import_id, txn_date, amount, direction, description, balance, dedupe_key, status, duplicate_of_id)
     values ($1, $4, $5, $6, '2026-10-27', 9020, 'expense', 'SAMPLE TELECOM', 100000, 'upg-1:suspected:x', 'duplicate_suspected', $2),
            ($7, $4, $5, $6, '2026-10-31', 1000, 'expense', 'SAMPLE SHOP', null, 'upg-3:suspected:x', 'duplicate_suspected', $3)`,
    [TXN_5, txnIds["upg-1"], txnIds["upg-3"], CUSTOMER_A, WALLET_A, IMPORT_2, TXN_6],
  );

  // 判断ログ 2 件（upg-1: 保留、upg-2: 管理者が承認 → 承認済みの過去仕訳が増える）
  const decide = (txn: string, accountItemId: number, taxCode: number, partnerKey: string, amount: number) =>
    inTx(client, "service", async () =>
      (
        await client.query<{ id: string }>("select public.record_ai_decision($1) as id", [
          JSON.stringify({
            customer_id: CUSTOMER_A,
            bank_transaction_id: txn,
            transaction_snapshot: { amount, partnerKey },
            proposal: { account_item_id: accountItemId, tax_code: taxCode },
            confidence: "high",
            confidence_breakdown: {},
            model: null,
            prompt_version: null,
          }),
        ])
      ).rows[0]!.id,
    );
  const d1 = await decide(txnIds["upg-1"]!, 101, 21, "サンプルツウシン", 9020);
  const d2 = await decide(txnIds["upg-2"]!, 106, 31, "サンプルクライアント", 330000);
  await inTx(client, "staff", () => client.query("select public.record_human_review($1, 'hold', null, '請求書の到着待ち', 3, false)", [d1]));
  await inTx(client, "admin", () => client.query("select public.record_human_review($1, 'approve', null, null, 4, false)", [d2]));

  // 重複の確認 1 件（upg-3 の控えを管理者が「重複」として除外）
  await inTx(client, "admin", () => client.query("select public.resolve_suspected_duplicate($1, 'duplicate', '同じ明細（合成）')", [TXN_6]));

  // ルール（版 1 有効 → 版 2 無効）、メモ（版 1 無効 → 版 2 有効）、過去仕訳（freee 由来）。テーブル所有者の権限で直接作る
  await client.query("insert into public.journal_rules (id, customer_id, created_by) values ($1, $2, $3)", [RULE_X, CUSTOMER_A, ADMIN_ID]);
  await client.query(
    `insert into public.journal_rule_versions (rule_id, version, customer_id, priority, status, source, cond_partner_key, cond_direction, account_item_id, tax_code, created_by)
     values ($1, 1, $2, 20, 'active', 'staff', 'サンプルクライアント', 'income', 106, 31, $3),
            ($1, 2, $2, 20, 'inactive', 'staff', 'サンプルクライアント', 'income', 106, 31, $3)`,
    [RULE_X, CUSTOMER_A, ADMIN_ID],
  );
  await client.query("insert into public.customer_notes (id, customer_id, created_by) values ($1, $2, $3)", [NOTE_X, CUSTOMER_A, ADMIN_ID]);
  await client.query(
    `insert into public.customer_note_versions (note_id, version, customer_id, status, title, body, created_by)
     values ($1, 1, $2, 'inactive', '合成メモ', '初版の本文（合成）', $3),
            ($1, 2, $2, 'active', '合成メモ', '改訂後の本文（合成）', $3)`,
    [NOTE_X, CUSTOMER_A, ADMIN_ID],
  );
  await client.query(
    `insert into public.past_journal_entries (customer_id, source, freee_source_id, entry_date, amount, direction, partner_key, account_item_id, tax_code)
     values ($1, 'freee_deal', 98001, '2026-09-01', 4000, 'expense', '合成キー', 102, 21)`,
    [CUSTOMER_A],
  );
}

describe("ベースラインの架空データ（アップグレード前）", () => {
  it("件数・金額・履歴が想定どおりに作られている", async () => {
    expect(beforeMoney.txns).toEqual([
      { status: "approved", direction: "income", n: 1, s: "330000" },
      { status: "duplicate", direction: "expense", n: 1, s: "1000" },
      { status: "duplicate_suspected", direction: "expense", n: 1, s: "9020" },
      { status: "new", direction: "expense", n: 1, s: "1000" },
      { status: "on_hold", direction: "expense", n: 1, s: "9020" },
    ]);
    expect(beforeMoney.imports).toEqual({ n: 2, row_count: "5", inserted: "3", skipped: "0", suspected: "2", income: "330000", expense: "20040" });

    const count = async (sql: string) => Number((await client.query<{ n: string }>(sql)).rows[0]!.n);
    expect(await count("select count(*) as n from public.ai_decisions")).toBe(2);
    expect(await count("select count(*) as n from public.human_reviews")).toBe(2);
    expect(await count("select count(*) as n from public.duplicate_reviews")).toBe(1);
    expect(await count("select count(*) as n from public.journal_rules")).toBe(2); // seed 1 + 合成 1
    expect(await count("select count(*) as n from public.journal_rule_versions")).toBe(3);
    expect(await count("select count(*) as n from public.customer_notes")).toBe(2);
    expect(await count("select count(*) as n from public.customer_note_versions")).toBe(3);
    expect(await count("select count(*) as n from public.past_journal_entries")).toBe(10); // seed 8 + 承認 1 + 合成 1
    // ベースラインには新しい関数・列がまだない
    expect(await count(`select count(*) as n from pg_proc where proname = any ('{${NEW_FUNCTIONS.join(",")}}')`)).toBe(0);
    expect(await count("select count(*) as n from information_schema.columns where table_name = 'statement_imports' and column_name = 'batch_hash'")).toBe(0);
    expect(Object.keys(before).filter((t) => NEW_INTERNAL_TABLES.includes(t))).toEqual([]); // 内部の表もまだ無い
  });
});

describe("20261023000100〜20261105041046 の適用（既存データのアップグレード）", () => {
  it("適用の前後で、既存の行・ID・件数・金額・履歴が1行も変わらず、増えるのは内部の 2 表だけ（位置は初期値、貸出しは空）", async () => {
    for (const name of UPGRADE_MIGRATIONS) {
      await client.query(readFileSync(join(process.cwd(), "supabase/migrations", name), "utf8"));
    }
    const { existing, added } = splitInternal(await snapshot(client));

    // 既存のテーブル全体が同一（取込記録の batch_hash 列だけは新設で、比較から除いている）
    expect(existing).toEqual(before);
    expect(await money(client)).toEqual(beforeMoney);
    // 新しく加わった表は想定した 2 つだけ。位置は 1 行（先頭から）、貸出しは 1 行もない
    expect(Object.keys(added).sort()).toEqual(NEW_INTERNAL_TABLES);
    expect(added.proposal_leases).toEqual([]);
    expect(added.proposal_scan_cursor).toHaveLength(1);
    expect(JSON.parse(added.proposal_scan_cursor![0]!)).toMatchObject({ singleton: true, last_txn_date: null, last_id: null });

    // 既存の取込記録は内容を確かめられないので、batch_hash は null のまま
    const hashes = await client.query<{ n: string }>("select count(*) as n from public.statement_imports where batch_hash is not null");
    expect(Number(hashes.rows[0]!.n)).toBe(0);
    // 新しい関数が入った（既存の record_ai_decision などは置き換わらず、署名も増えていない）
    const fns = await client.query<{ proname: string }>(
      `select proname from pg_proc where pronamespace = 'public'::regnamespace and proname = any ($1) order by proname`,
      [NEW_FUNCTIONS],
    );
    expect(fns.rows.map((r) => r.proname)).toEqual([...NEW_FUNCTIONS].sort());
    const overloads = await client.query<{ n: string }>("select count(*) as n from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_ai_decision'");
    expect(Number(overloads.rows[0]!.n)).toBe(1);
  });

  it("追記専用は維持される（判断ログ・確認ログ・版の更新・削除は拒否）", async () => {
    for (const sql of [
      "update public.ai_decisions set confidence = 'low'",
      "delete from public.human_reviews",
      "delete from public.duplicate_reviews",
      "update public.journal_rule_versions set priority = 1",
      "delete from public.customer_note_versions",
    ]) {
      await client.query("begin");
      try {
        await expect(client.query(sql)).rejects.toThrow(/append-only/);
      } finally {
        await client.query("rollback");
      }
    }
    const { existing, added } = splitInternal(await snapshot(client));
    expect(existing).toEqual(before);
    expect(added.proposal_leases).toEqual([]);
  });
});

describe("アップグレード後の関数（既存データの上で動く）", () => {
  it("この変更より前の取込と同じ内容の再取込は、読み飛ばさず全件を重複の疑いにする。件数・金額は照合され、元の明細は変わらない", async () => {
    const result = await importRows(client, "baseline-fixture-again.csv", FIXTURE_ROWS);
    expect(result.import_id).not.toBe(fixtureImportId);
    expect(result).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 0, suspected_duplicate_count: 3 });
    expect(Number(result.income_total)).toBe(330000);
    expect(Number(result.expense_total)).toBe(10020);
    expect(Number(result.inserted_amount_total)).toBe(0);
    expect(Number(result.skipped_amount_total)).toBe(0);
    expect(Number(result.suspected_amount_total)).toBe(340020);

    const rows = await client.query<{ dedupe_key: string; status: string; duplicate_of_id: string }>(
      "select dedupe_key, status, duplicate_of_id from public.bank_transactions where import_id = $1 order by dedupe_key",
      [result.import_id],
    );
    expect(rows.rows).toEqual(
      ["upg-1", "upg-2", "upg-3"].map((k) => ({ dedupe_key: `${k}:suspected:${result.import_id}`, status: "duplicate_suspected", duplicate_of_id: txnIds[k] })),
    );
  });

  it("アップグレード後に取り込んだ内容は、同じ内容の再取込で読み飛ばされる（全行の件数・金額が照合される）", async () => {
    const rows: ImportRow[] = [
      { txn_date: "2026-11-01", amount: 700, direction: "expense", description: "SAMPLE POST-UPGRADE A", balance: 5000, dedupe_key: "upg-new-1" },
      { txn_date: "2026-11-02", amount: 1200, direction: "income", description: "SAMPLE POST-UPGRADE B", balance: 6200, dedupe_key: "upg-new-2" },
    ];
    const first = await importRows(client, "post-upgrade.csv", rows);
    expect(first).toMatchObject({ inserted_count: 2, skipped_duplicate_count: 0, suspected_duplicate_count: 0 });
    const replay = await importRows(client, "post-upgrade-replay.csv", rows);
    expect(replay).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 2, suspected_duplicate_count: 0 });
    expect(Number(replay.skipped_amount_total)).toBe(1900);
    const n = await client.query<{ n: string }>("select count(*) as n from public.bank_transactions where dedupe_key like 'upg-new-%'");
    expect(Number(n.rows[0]!.n)).toBe(2);
  });

  it("AI判断の記録は未判定（new）の明細にだけ通り、保留中・承認済みの明細には拒否される（既存の判断・確認は変わらない）", async () => {
    const record = (txn: string): [string, unknown[]] =>
      [
        "select public.record_ai_decision($1) as id",
        [
          JSON.stringify({
            customer_id: CUSTOMER_A,
            bank_transaction_id: txn,
            transaction_snapshot: { amount: 1 },
            proposal: { account_item_id: 102, tax_code: 21 },
            confidence: "low",
            confidence_breakdown: {},
            model: null,
            prompt_version: null,
          }),
        ],
      ];
    for (const key of ["upg-1", "upg-2"]) {
      const failure = await expectFailure(client, "service", ...record(txnIds[key]!));
      expect(failure.message).toMatch(/is not waiting for a proposal/);
    }
    // 受理されるのは、アップグレード後に取り込んだ未判定の明細（既存の明細は変えない）
    const fresh = await client.query<{ id: string }>("select id from public.bank_transactions where dedupe_key = 'upg-new-1'");
    await inTx(client, "service", () => client.query(...record(fresh.rows[0]!.id)));
    const status = await client.query<{ status: string }>("select status from public.bank_transactions where id = $1", [fresh.rows[0]!.id]);
    expect(status.rows[0]!.status).toBe("proposed");
  });

  it("record_human_review: 同じ署名のまま権限・所有者・search_path が保たれ、アップグレード前に保留された候補への保留は担当者・管理者とも拒否され、履歴は1行も増減しない", async () => {
    // 関数は置き換わっただけ（オーバーロードなし、所有者・ACL・security definer・search_path は前と同じ）。
    // service_role の実行権は環境の既定権限（Supabase イメージのクラスタ／default privileges）で変わりうるので、
    // 固定値では比べず、ベースライン（適用前）と同じであることだけを求める（上の厳密な等価比較に含まれる）
    const shape = await reviewFunctionShape();
    expect(shape).toEqual(reviewFnBefore);
    expect(shape.svc).toBe(reviewFnBefore.svc);
    expect(shape).toMatchObject({ secdef: true, anon: false, auth: true, public_exec: false, count: "1" });
    expect(reviewFnBefore).toMatchObject({ anon: false, auth: true, public_exec: false }); // 適用前から PUBLIC・anon には実行権がない
    expect(shape.config).toEqual(['search_path=""']);

    // upg-1 はアップグレード前に担当者が保留した候補（ベースラインの関数が記録した 1 行）
    const decision = await client.query<{ id: string }>("select id from public.ai_decisions where bank_transaction_id = $1", [txnIds["upg-1"]]);
    const decisionId = decision.rows[0]!.id;
    const reviews = () => client.query("select * from public.human_reviews where ai_decision_id = $1 order by created_at, id", [decisionId]);
    const heldBefore = (await reviews()).rows;
    expect(heldBefore).toHaveLength(1);
    expect(heldBefore[0]).toMatchObject({ action: "hold", review_seconds: 3, reason: "請求書の到着待ち" });

    const allReviewsBefore = (await snapshot(client)).human_reviews;
    for (const [actor, seconds] of [["staff", 45], ["admin", 30], ["staff", 0]] as const) {
      const failure = await expectFailure(client, actor, "select public.record_human_review($1, 'hold', null, '再送（合成）', $2, false)", [decisionId, seconds]);
      expect(failure.message).toMatch(/すでに保留/);
      expect(failure.code).toBe("P0001");
    }
    // 拒否はロールバックされ、保留の行・確認時間・状態・過去仕訳は変わらない
    expect((await reviews()).rows).toEqual(heldBefore);
    expect((await snapshot(client)).human_reviews).toEqual(allReviewsBefore);
    const status = await client.query<{ status: string }>("select status from public.bank_transactions where id = $1", [txnIds["upg-1"]]);
    expect(status.rows[0]!.status).toBe("on_hold");
    // 権限のない呼出しは、状態を漏らさず従来どおりの拒否（担当者の承認は管理者だけ）
    const staffApprove = await expectFailure(client, "staff", "select public.record_human_review($1, 'approve', null, null, 1, false)", [decisionId]);
    expect(staffApprove.code).toBe("42501");
    expect(staffApprove.message).not.toMatch(/すでに保留/);
    // 履歴の訂正・削除は引き続き拒否される（このテストは履歴を編集しない）
    await client.query("begin");
    try {
      await expect(client.query("delete from public.human_reviews where ai_decision_id = $1", [decisionId])).rejects.toThrow(/append-only/);
    } finally {
      await client.query("rollback");
    }
  });

  it("create_rule_from_past_candidate: 既存の過去仕訳から親と版1（提案中）を1回だけ作り、同じIDの2回目は 23505 で何も変えない", async () => {
    const sql = "select public.create_rule_from_past_candidate($1, $2, 'サンプルフドウサン', 'expense', 105, 21, 50) as id";
    const res = await inTx(client, "staff", () => client.query<{ id: string }>(sql, [CUSTOMER_A, NEW_RULE]));
    expect(res.rows[0]!.id).toBe(NEW_RULE);
    const version = await client.query("select version, status, source, priority, account_item_id, created_by from public.journal_rule_versions where rule_id = $1", [NEW_RULE]);
    expect(version.rows).toEqual([{ version: 1, status: "proposed", source: "past_entries", priority: 50, account_item_id: "105", created_by: STAFF_ID }]);
    const again = await expectFailure(client, "staff", sql, [CUSTOMER_A, NEW_RULE]);
    expect(again.code).toBe("23505");
  });

  it("create_customer_note: 親と版1（無効）を1回だけ作り、同じIDの2回目は 23505 で何も変えない", async () => {
    const sql = "select public.create_customer_note($1, $2, 'アップグレード後のメモ', '本文（合成）') as id";
    const res = await inTx(client, "staff", () => client.query<{ id: string }>(sql, [CUSTOMER_A, NEW_NOTE]));
    expect(res.rows[0]!.id).toBe(NEW_NOTE);
    const version = await client.query("select version, status, title, body, created_by from public.customer_note_versions where note_id = $1", [NEW_NOTE]);
    expect(version.rows).toEqual([{ version: 1, status: "inactive", title: "アップグレード後のメモ", body: "本文（合成）", created_by: STAFF_ID }]);
    const again = await expectFailure(client, "staff", sql, [CUSTOMER_A, NEW_NOTE]);
    expect(again.code).toBe("23505");
  });

  it("上の操作のあとも、アップグレード前の行はすべてそのまま残り、増えたのは想定した行だけ", async () => {
    const after = await snapshot(client);
    expectBaselineRowsKept(before, after);
    expect(countDelta(before, after)).toEqual({
      statement_imports: 3, // 再取込 1 + 取込後の 2
      bank_transactions: 5, // 再取込の重複の疑い 3 + 取込後の新規 2（読み飛ばした再取込は明細を増やさない）
      ai_decisions: 1,
      journal_rules: 1,
      journal_rule_versions: 1,
      customer_notes: 1,
      customer_note_versions: 1,
    });
  });
});

describe("アップグレード後の走査位置・貸出し（RLS・権限と、既存データの上での実際の動作）", () => {
  const OWNER_1 = "76000000-0000-4000-8000-000000000001";
  const OWNER_2 = "76000000-0000-4000-8000-000000000002";
  const OWNER_3 = "76000000-0000-4000-8000-000000000003";
  const FUNCTIONS = [
    "public.claim_pending_proposal_batch(integer, uuid, integer)",
    "public.renew_proposal_claim(uuid, uuid, integer)",
    "public.release_proposal_claims(uuid, uuid[])",
    "public.record_claimed_ai_decision(uuid, jsonb)",
  ];

  const claimAs = (owner: string, limit = 200) =>
    inTx(client, "service", async () =>
      (await client.query<{ id: string }>("select id from public.claim_pending_proposal_batch($1, $2, 600)", [limit, owner])).rows.map((r) => r.id),
    );
  const renewAs = (owner: string, txn: string) =>
    inTx(client, "service", async () => (await client.query<{ ok: boolean }>("select public.renew_proposal_claim($1, $2, 600) as ok", [owner, txn])).rows[0]!.ok);
  const releaseAs = (owner: string, txns: string[]) =>
    inTx(client, "service", async () => (await client.query<{ n: number }>("select public.release_proposal_claims($1, $2::uuid[]) as n", [owner, txns])).rows[0]!.n);
  const decisionFor = (txn: string, customer: string) =>
    JSON.stringify({
      customer_id: customer,
      bank_transaction_id: txn,
      transaction_snapshot: { amount: 1 },
      proposal: { account_item_id: 102, tax_code: 21 },
      confidence: "low",
      confidence_breakdown: {},
      model: null,
      prompt_version: null,
    });
  const recordSql = "select public.record_claimed_ai_decision($1, $2::jsonb) as id";
  const leaseRows = async () =>
    (await client.query<{ id: string; owner: string }>("select bank_transaction_id as id, owner from public.proposal_leases order by bank_transaction_id")).rows;
  const decisionTotal = async () => Number((await client.query<{ n: string }>("select count(*) as n from public.ai_decisions")).rows[0]!.n);

  it("2 つの表は RLS が有効でポリシーが無く、anon・担当者は触れず、service_role には必要な権限だけがある", async () => {
    const rls = await client.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where oid = any (array['public.proposal_scan_cursor'::regclass, 'public.proposal_leases'::regclass]) order by relname",
    );
    expect(rls.rows).toEqual([
      { relname: "proposal_leases", relrowsecurity: true },
      { relname: "proposal_scan_cursor", relrowsecurity: true },
    ]);
    expect((await client.query("select policyname from pg_policies where tablename = any ($1)", [NEW_INTERNAL_TABLES])).rows).toEqual([]);

    const priv = async (role: string, table: string, p: string) =>
      (await client.query<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [role, `public.${table}`, p])).rows[0]!.ok;
    for (const role of ["anon", "authenticated"]) {
      for (const table of NEW_INTERNAL_TABLES) {
        for (const p of ["select", "insert", "update", "delete", "truncate"]) expect(await priv(role, table, p), `${role} ${p} ${table}`).toBe(false);
      }
    }
    for (const p of ["select", "update"]) expect(await priv("service_role", "proposal_scan_cursor", p), `service_role ${p} cursor`).toBe(true);
    for (const p of ["insert", "delete", "truncate"]) expect(await priv("service_role", "proposal_scan_cursor", p), `service_role ${p} cursor`).toBe(false);
    for (const p of ["select", "insert", "update", "delete"]) expect(await priv("service_role", "proposal_leases", p), `service_role ${p} leases`).toBe(true);
    expect(await priv("service_role", "proposal_leases", "truncate")).toBe(false);

    for (const fn of FUNCTIONS) {
      const acl = await client.query<{ proacl: string; anon: boolean; auth: boolean; svc: boolean; secdef: boolean }>(
        `select proacl::text,
                has_function_privilege('anon', oid, 'execute') as anon,
                has_function_privilege('authenticated', oid, 'execute') as auth,
                has_function_privilege('service_role', oid, 'execute') as svc,
                prosecdef as secdef
         from pg_proc where oid = $1::regprocedure`,
        [fn],
      );
      expect(acl.rows[0], fn).toMatchObject({ anon: false, auth: false, svc: true, secdef: false });
      expect(acl.rows[0]!.proacl, fn).not.toMatch(/(^\{|,)=X/); // PUBLIC への付与がない
    }
  });

  it("担当者・管理者は関数も表も実際に使えない（権限エラー）", async () => {
    for (const actor of ["staff", "admin"] as const) {
      const claim = await expectFailure(client, actor, "select * from public.claim_pending_proposal_batch(10, $1, 600)", [OWNER_1]);
      expect(claim.code).toBe("42501");
      const record = await expectFailure(client, actor, recordSql, [OWNER_1, decisionFor("71000000-0000-4000-8000-0000000000ff", CUSTOMER_A)]);
      expect(record.code).toBe("42501");
      for (const table of NEW_INTERNAL_TABLES) {
        expect((await expectFailure(client, actor, `select * from public.${table}`, [])).code).toBe("42501");
      }
    }
  });

  it("既存の未判定の明細に、実際の関数で貸出しと所有者の確認・期限切れ・返却・記録ができ、保留・承認済みなどの既存の行は変わらない", async () => {
    const pending = await client.query<{ id: string; customer_id: string }>("select id, customer_id from public.bank_transactions where status = 'new' order by txn_date, id");
    const pendingIds = pending.rows.map((r) => r.id);
    expect(pendingIds.length).toBeGreaterThan(1); // 取込時の upg-3 と取込後の upg-new-2 などがある
    expect(pendingIds.length).toBeLessThan(200);
    // 記録する明細は、アップグレード後に取り込んだ未判定の行（ベースラインの行は書き換えない）
    const firstRow = await client.query<{ id: string; customer_id: string }>("select id, customer_id from public.bank_transactions where dedupe_key = 'upg-new-2'");
    const first = firstRow.rows[0]!;
    expect(pendingIds).toContain(first.id);
    const rest = pendingIds.filter((v) => v !== first.id);
    const byId = (ids: string[]) => [...ids].sort();
    const nonNew = ["upg-1", "upg-2", TXN_5, TXN_6].map((k) => txnIds[k] ?? k);

    const moneyBefore = await money(client);
    const pre = splitInternal(await snapshot(client));

    // 1) 部分バッチ（上限 200 件未満）: 未判定を (txn_date, id) 順にすべて受け取り、位置は先頭に戻る
    const claimed = await claimAs(OWNER_1);
    expect(claimed).toEqual(pendingIds);
    for (const v of nonNew) expect(claimed).not.toContain(v); // 保留・承認済み・重複の疑いは渡らない
    expect((await leaseRows()).map((r) => [r.id, r.owner])).toEqual(byId(pendingIds).map((v) => [v, OWNER_1]));
    const cursorRow = await client.query("select last_txn_date, last_id from public.proposal_scan_cursor");
    expect(cursorRow.rows).toEqual([{ last_txn_date: null, last_id: null }]);

    // 渡しただけでは業務データは1行も変わらない（金額・件数・履歴・IDとも）
    const mid = splitInternal(await snapshot(client));
    expect(mid.existing).toEqual(pre.existing);
    expect(await money(client)).toEqual(moneyBefore);

    // 2) 折返しの直後に別の所有者が来ても、記録前の明細は渡らない。所有者でない記録・確認は拒否される
    expect(await claimAs(OWNER_2)).toEqual([]);
    const decisionsBefore = await decisionTotal();
    const notOwner = await expectFailure(client, "service", recordSql, [OWNER_2, decisionFor(first.id, first.customer_id)]);
    expect(notOwner.message).toMatch(/is not held by this owner/);
    expect(await renewAs(OWNER_2, first.id)).toBe(false);
    expect(await renewAs(OWNER_1, first.id)).toBe(true);
    // 既存の保留の明細は、貸出しがないので記録できない（保留の理由・履歴は変わらない）
    const onHold = await expectFailure(client, "service", recordSql, [OWNER_1, decisionFor(txnIds["upg-1"]!, CUSTOMER_A)]);
    expect(onHold.message).toMatch(/is not held by this owner/);
    expect(await decisionTotal()).toBe(decisionsBefore);

    // 3) 期限が切れて別の所有者に奪われた古い所有者は、確認も記録もできない。奪った側が記録すると、判断が 1 行増えて proposed になる
    await client.query("update public.proposal_leases set lease_expires_at = now() - interval '1 second'");
    expect(await claimAs(OWNER_2)).toEqual(pendingIds);
    expect(await renewAs(OWNER_1, first.id)).toBe(false);
    const stale = await expectFailure(client, "service", recordSql, [OWNER_1, decisionFor(first.id, first.customer_id)]);
    expect(stale.message).toMatch(/is not held by this owner/);
    expect(await decisionTotal()).toBe(decisionsBefore);

    // 他の顧客の ID では、所有者でも記録できない
    const otherCustomer = first.customer_id === CUSTOMER_A ? "10000000-0000-4000-8000-000000000002" : CUSTOMER_A;
    const crossTenant = await expectFailure(client, "service", recordSql, [OWNER_2, decisionFor(first.id, otherCustomer)]);
    expect(crossTenant.message).toMatch(/is not waiting for a proposal/);

    await inTx(client, "service", () => client.query(recordSql, [OWNER_2, decisionFor(first.id, first.customer_id)]));
    expect(await decisionTotal()).toBe(decisionsBefore + 1);
    const status = await client.query<{ status: string }>("select status from public.bank_transactions where id = $1", [first.id]);
    expect(status.rows[0]!.status).toBe("proposed");
    expect((await leaseRows()).map((r) => r.id)).toEqual(byId(rest)); // 記録した分の貸出しは終わった

    // 4) 失敗した分を返すと new のまま残り、次の巡回で別の所有者に再び渡る（再試行）
    expect(await releaseAs(OWNER_1, rest)).toBe(0); // 古い所有者の返却は奪った側の貸出しに触れない
    expect(await releaseAs(OWNER_2, rest)).toBe(rest.length);
    expect(await leaseRows()).toEqual([]);
    expect(await claimAs(OWNER_3)).toEqual(rest);
    expect(await releaseAs(OWNER_3, rest)).toBe(rest.length);

    // 既存の行（ベースラインの行・保留・承認済み・重複の確認）は1行も変わらず、変わったのは記録した1明細の状態と判断ログの1行だけ
    const post = splitInternal(await snapshot(client));
    expectBaselineRowsKept(before, post.existing);
    expect(countDelta(pre.existing, post.existing)).toEqual({ ai_decisions: 1 });
    expect(await leaseRows()).toEqual([]);
  });
});
