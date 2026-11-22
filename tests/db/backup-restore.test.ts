import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyShim, createDisposableDatabase, noop, openClient, validateBaseUrl, type DisposableDatabase } from "./disposable-db";
import { ADMIN_ID, CUSTOMER_A, CUSTOMER_B, STAFF_ID, WALLET_A } from "./helpers";
import {
  assertPlainBaseUrl,
  buildChildEnv,
  parseMajor,
  requireDisposableOptIn,
  requirePgMajor,
  resolveToolPaths,
  runTool,
  secretsOf,
} from "./pg-cli";

/**
 * pg_dump（custom 形式）→ pg_restore のバックアップ・復元の検証（ローカル専用・合成データだけ）。
 *
 * 範囲: 同じクラスタ内の、このテストが新しく作った 2 つの使い捨てデータベース（元と復元先）だけ。
 * - 元: 現在の shim・マイグレーション・seed に、合成の業務（取込・AI判断・保留と承認・ルールとメモの版）を足す
 * - 復元先: 作ったばかりの空のデータベースに pg_restore（--clean も --create も使わない）
 * - 比べるもの: 全テーブルの全行、構造（RLS・ポリシー・ACL・トリガー・制約・関数）、ロール別の許可と拒否、復元後の次の書込み
 *
 * 範囲外（これで確認したとは言わない）:
 * - pg_dump はクラスタ共通のロール（anon / authenticated / service_role）を保存しない。ここでは同じクラスタの既存ロールを再利用する。
 *   別クラスタへの復元では、ロールを先に作る必要がある
 * - 実際の Supabase の災害復旧（auth・storage・Vault・プロバイダのバックアップ、PITR、リージョン、権限移行）の確認ではない
 *
 * 実行条件: TEST_DATABASE_DISPOSABLE=1（この検証専用に新しく作った使い捨てクラスタのスーパーユーザー）、
 * TEST_PG_MAJOR（16 または 17）と、その版の PG<版>_PG_DUMP / PG<版>_PG_RESTORE（絶対パス）。
 * サーバー・pg_dump・pg_restore のメジャー版がすべて TEST_PG_MAJOR と一致することを要求する。インストールはしない。足りなければ明確に失敗する。
 */

const SOURCE_PREFIX = "mvp_bkp_src_";
const RESTORE_PREFIX = "mvp_bkp_dst_";

// 架空の固定 ID（seed の ID と重ならない値）
const NEW_RULE = "76000000-0000-4000-8000-000000000001";
const NEW_NOTE = "77000000-0000-4000-8000-000000000001";
const AFTER_RULE = "76000000-0000-4000-8000-000000000002";
const SEED_RULE = "30000000-0000-4000-8000-000000000001";
const SEED_NOTE = "31000000-0000-4000-8000-000000000001";

// ---------------------------------------------------------------------------------------------
// セッションの道具

type Actor = "owner" | "anon" | "staff" | "admin" | "service";

async function inTx<T>(client: Client, actor: Actor, fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    if (actor === "anon" || actor === "service") {
      await client.query(`set local role ${actor === "anon" ? "anon" : "service_role"}`);
    } else if (actor !== "owner") {
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

async function expectFailure(client: Client, actor: Actor, sql: string, params: unknown[] = []): Promise<{ code: string | undefined; message: string }> {
  try {
    await inTx(client, actor, () => client.query(sql, params));
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { code: e.code, message: e.message ?? "" };
  }
  throw new Error(`expected failure: ${sql}`);
}

type ImportRow = { txn_date: string; amount: number; direction: "income" | "expense"; description: string; balance: number | null; dedupe_key: string };
type ImportResult = { import_id: string; inserted_count: number; skipped_duplicate_count: number; suspected_duplicate_count: number; income_total: string; expense_total: string; inserted_amount_total: string };

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

const WORKFLOW_ROWS: ImportRow[] = [
  { txn_date: "2026-10-27", amount: 9020, direction: "expense", description: "SAMPLE TELECOM", balance: 100000, dedupe_key: "bkp-1" },
  { txn_date: "2026-10-31", amount: 330000, direction: "income", description: "SAMPLE CLIENT", balance: 430000, dedupe_key: "bkp-2" },
  // 残高がある行だけが再取込で読み飛ばされる（残高なしは重複の疑いに回る）ので、3 行とも残高を持たせる
  { txn_date: "2026-10-31", amount: 1000, direction: "expense", description: "SAMPLE SHOP", balance: 429000, dedupe_key: "bkp-3" },
];

const recordDecision = (client: Client, txn: string, extra: Record<string, unknown> = {}) =>
  inTx(client, "service", async () =>
    (
      await client.query<{ id: string }>("select public.record_ai_decision($1) as id", [
        JSON.stringify({
          customer_id: CUSTOMER_A,
          bank_transaction_id: txn,
          transaction_snapshot: { amount: 1 },
          proposal: { account_item_id: 101, tax_code: 21 },
          confidence: "high",
          confidence_breakdown: {},
          model: null,
          prompt_version: null,
          ...extra,
        }),
      ])
    ).rows[0]!.id,
  );

// ---------------------------------------------------------------------------------------------
// 比較用のスナップショット

/** public の全テーブルと auth.users の全行（テーブル名 → ソート済みの JSON 文字列） */
async function rowSnapshot(client: Client): Promise<Record<string, string[]>> {
  const tables = await client.query<{ q: string }>(
    `select table_schema || '.' || table_name as q from information_schema.tables
     where table_type = 'BASE TABLE' and (table_schema = 'public' or (table_schema = 'auth' and table_name = 'users')) order by 1`,
  );
  const result: Record<string, string[]> = {};
  for (const { q } of tables.rows) {
    const [schema, table] = q.split(".") as [string, string];
    const rows = await client.query<{ r: string }>(`select to_jsonb(t)::text as r from ${client.escapeIdentifier(schema)}.${client.escapeIdentifier(table)} t`);
    result[q] = rows.rows.map((x) => x.r).sort();
  }
  return result;
}

/** RLS・ポリシー・ACL・権限・トリガー・制約・関数・既定権限。復元後も元と同一でなければならない */
async function structure(client: Client) {
  const q = async (sql: string) => (await client.query(sql)).rows;
  return {
    relations: await q(
      `select c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relacl::text as acl, pg_get_userbyid(c.relowner) as owner
       from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'S') order by c.relname`,
    ),
    policies: await q(
      `select tablename, policyname, cmd, roles::text as roles, qual, with_check from pg_policies where schemaname = 'public' order by tablename, policyname`,
    ),
    privileges: await q(
      `select c.relname, r.rolname, p.priv, has_table_privilege(r.rolname, c.oid, p.priv) as allowed
       from pg_class c, (values ('anon'), ('authenticated'), ('service_role')) r(rolname),
            (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v') order by 1, 2, 3`,
    ),
    functions: await q(
      `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.proacl::text as acl, p.proconfig::text as config, md5(p.prosrc) as src
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'auth') order by 1, 2, 3`,
    ),
    triggers: await q(
      `select c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) as def from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relnamespace = 'public'::regnamespace and not t.tgisinternal order by 1, 2`,
    ),
    constraints: await q(`select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`),
    defaultAcls: await q(`select pg_get_userbyid(defaclrole) as role, defaclobjtype, defaclacl::text as acl from pg_default_acl order by 1, 2, 3`),
  };
}

/** 取込 bkp-* の件数・金額（状態別） */
async function workflowMoney(client: Client) {
  return (
    await client.query(
      `select status, direction, count(*)::int as n, sum(amount)::text as s from public.bank_transactions
       where customer_id = $1 and dedupe_key like 'bkp-%' group by status, direction order by status, direction`,
      [CUSTOMER_A],
    )
  ).rows;
}

/** AI判断ログ・人の確認ログ・ルール／メモの版（参照関係を含む）の中身 */
async function histories(client: Client) {
  const q = async (sql: string) => (await client.query(sql)).rows;
  return {
    decisions: await q(
      `select d.id, d.bank_transaction_id, d.confidence, d.model, d.prompt_version, d.input_tokens, d.output_tokens, d.cost_usd_micros,
              d.rule_versions_used, d.note_versions_used, d.past_entry_ids, d.ai_unknowns from public.ai_decisions d order by d.id`,
    ),
    reviews: await q(`select id, ai_decision_id, action, reason, reviewer_id, review_seconds, bulk, final_entry from public.human_reviews order by id`),
    ruleVersions: await q(`select rule_id, version, status, source, priority, account_item_id::text as account_item_id, created_by from public.journal_rule_versions order by rule_id, version`),
    noteVersions: await q(`select note_id, version, status, title, body, created_by from public.customer_note_versions order by note_id, version`),
    pastEntries: await q(`select id, ai_decision_id, entry_date, amount::text as amount, direction, partner_key from public.past_journal_entries order by id`),
  };
}

// ---------------------------------------------------------------------------------------------

let source: DisposableDatabase | undefined;
let target: DisposableDatabase | undefined;
let src: Client | undefined;
let dst: Client | undefined;
let workDir: string | undefined;

let sourceRows: Record<string, string[]>;
let sourceStructure: Awaited<ReturnType<typeof structure>>;
let sourceMoney: Awaited<ReturnType<typeof workflowMoney>>;
let sourceHistories: Awaited<ReturnType<typeof histories>>;
let decisionIds: { hold: string; approve: string } = { hold: "", approve: "" };

async function cleanup() {
  // 作った 2 つのデータベースと一時ディレクトリだけを片付ける。失敗しても残りの後始末は続ける
  await Promise.allSettled([src?.end().catch(noop), dst?.end().catch(noop)]);
  for (const db of [target, source]) {
    await db?.drop().catch(() => console.warn(`could not drop the disposable database ${db.name}; drop it manually`));
  }
  if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => console.warn("could not remove the temporary dump directory"));
}

// opt-in がなければこのファイルのテストは実行されない（skipped と表示される。成功とは扱わない）
const enabled = process.env.TEST_DATABASE_DISPOSABLE === "1";

beforeAll(async () => {
  if (!enabled) return;
  // 1. 破壊的な後始末を伴うので、明示の opt-in と localhost・query なしの URL を、クライアントや CLI を呼ぶ前に確認する
  requireDisposableOptIn();
  const base = validateBaseUrl();
  assertPlainBaseUrl(base);
  const major = requirePgMajor();
  const tools = resolveToolPaths();
  const secrets = secretsOf(base);

  try {
    // 2. サーバーがスーパーユーザーで接続でき、メジャー版が CLI と一致すること
    const admin = await openClient(base.toString(), "backup-restore-check");
    let serverMajor: number;
    try {
      const info = await admin.query<{ rolsuper: boolean; num: string }>(
        "select (select rolsuper from pg_roles where rolname = current_user) as rolsuper, current_setting('server_version_num') as num",
      );
      expect(info.rows[0]!.rolsuper, "a dedicated disposable superuser cluster is required").toBe(true);
      serverMajor = Math.floor(Number(info.rows[0]!.num) / 10000);
    } finally {
      await admin.end().catch(noop);
    }
    expect(serverMajor, `server major must be TEST_PG_MAJOR=${major}`).toBe(major);
    const baseEnv = buildChildEnv(process.env, base, "postgres");
    for (const [label, file] of [
      ["pg_dump", tools.pgDump],
      ["pg_restore", tools.pgRestore],
    ] as const) {
      expect(parseMajor(await runTool(`${label} --version`, file, ["--version"], baseEnv, 15_000, secrets)), `${label} major must match the server`).toBe(serverMajor);
    }

    // 3. このテストが新しく作る使い捨てデータベース 2 つ（既存の DB は指定できない）
    source = await createDisposableDatabase(base, SOURCE_PREFIX);
    target = await createDisposableDatabase(base, RESTORE_PREFIX);
    workDir = await mkdtemp(join(tmpdir(), "mvp-bkp-"));
    src = await openClient(source.url, "backup-restore-source");

    // 4. 元: 現在の shim → マイグレーション → seed（scripts/apply-migrations.sh と同じ順）、そのうえで合成の業務
    await applyShim(src, readFileSync(join(process.cwd(), "tests/db/supabase-shim.sql"), "utf8"));
    for (const dir of ["supabase/migrations", "supabase/seed"]) {
      for (const name of readdirSync(join(process.cwd(), dir)).filter((n) => n.endsWith(".sql")).sort()) {
        await src.query(readFileSync(join(process.cwd(), dir, name), "utf8"));
      }
    }
    await buildWorkflow(src);
    sourceRows = await rowSnapshot(src);
    sourceStructure = await structure(src);
    sourceMoney = await workflowMoney(src);
    sourceHistories = await histories(src);

    // 5. custom 形式でダンプし、空の復元先へ pg_restore（--clean・--create なし。1 つでも失敗したら止める）
    const dumpPath = join(workDir, "source.dump");
    await runTool(
      "pg_dump",
      tools.pgDump,
      ["--format=custom", `--file=${dumpPath}`, "--no-password", "--lock-wait-timeout=30000", `--dbname=${source.name}`],
      buildChildEnv(process.env, base, source.name),
      120_000,
      secrets,
    );
    const probe = await openClient(target.url, "backup-restore-empty-check");
    try {
      const objects = await probe.query<{ n: string }>(
        `select count(*) as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and n.nspname !~ '^pg_'`,
      );
      expect(Number(objects.rows[0]!.n), "the restore target must be newly empty").toBe(0);
    } finally {
      await probe.end().catch(noop);
    }
    await runTool(
      "pg_restore",
      tools.pgRestore,
      ["--exit-on-error", "--single-transaction", "--no-password", `--dbname=${target.name}`, dumpPath],
      buildChildEnv(process.env, base, target.name),
      180_000,
      secrets,
    );
    dst = await openClient(target.url, "backup-restore-target");
  } catch (error) {
    await cleanup();
    throw error;
  }
}, 420_000);

afterAll(cleanup, 90_000);

/** 取込 → AI判断（ルール・メモ・過去仕訳・モデルの参照つき）→ 保留・承認 → ルールとメモの版 */
async function buildWorkflow(c: Client) {
  const first = await importRows(c, "backup-fixture.csv", WORKFLOW_ROWS);
  expect(first).toMatchObject({ inserted_count: 3, skipped_duplicate_count: 0, suspected_duplicate_count: 0 });
  expect([Number(first.income_total), Number(first.expense_total)]).toEqual([330000, 10020]);
  const ids = await c.query<{ id: string; dedupe_key: string }>("select id, dedupe_key from public.bank_transactions where dedupe_key like 'bkp-%'");
  const txn = Object.fromEntries(ids.rows.map((r) => [r.dedupe_key, r.id])) as Record<string, string>;

  const past = await c.query<{ id: string }>("select id from public.past_journal_entries where customer_id = $1 order by id limit 1", [CUSTOMER_A]);
  const refs = {
    rule_versions_used: [{ rule_id: SEED_RULE, version: 1 }],
    note_versions_used: [{ note_id: SEED_NOTE, version: 1 }],
    past_entry_ids: [past.rows[0]!.id],
    ai_output: { account_item_id: 101, tax_code: 21 },
    ai_reason: "合成の理由",
    ai_unknowns: ["合成の不明点"],
    model: "synthetic-model",
    prompt_version: "synthetic-prompt-v0",
    input_tokens: 120,
    output_tokens: 30,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd_micros: 1234,
  };
  const hold = await recordDecision(c, txn["bkp-1"]!, refs);
  const approve = await recordDecision(c, txn["bkp-2"]!, { ...refs, proposal: { account_item_id: 106, tax_code: 31 } });
  decisionIds = { hold, approve };
  await inTx(c, "staff", () => c.query("select public.record_human_review($1, 'hold', null, '請求書の到着待ち', 3, false)", [hold]));
  await inTx(c, "admin", () => c.query("select public.record_human_review($1, 'approve', null, null, 4, false)", [approve]));

  // ルールの版（新規の親 + 版 1、続けて版 2）とメモの版（同様）
  await inTx(c, "staff", () => c.query("select public.create_rule_from_past_candidate($1, $2, 'サンプルツウシン', 'expense', 101, 21, 50)", [CUSTOMER_A, NEW_RULE]));
  await c.query(
    `insert into public.journal_rule_versions (rule_id, version, customer_id, priority, status, source, cond_partner_key, cond_direction, account_item_id, tax_code, created_by)
     values ($1, 2, $2, 40, 'proposed', 'staff', 'サンプルツウシン', 'expense', 101, 21, $3)`,
    [NEW_RULE, CUSTOMER_A, STAFF_ID],
  );
  await inTx(c, "staff", () => c.query("select public.create_customer_note($1, $2, '合成メモ', '初版の本文（合成）')", [CUSTOMER_A, NEW_NOTE]));
  await c.query(
    `insert into public.customer_note_versions (note_id, version, customer_id, status, title, body, created_by) values ($1, 2, $2, 'inactive', '合成メモ', '改訂後の本文（合成）', $3)`,
    [NEW_NOTE, CUSTOMER_A, STAFF_ID],
  );
}

// ---------------------------------------------------------------------------------------------

describe.skipIf(!enabled)("復元後のデータ（元と同一）", () => {
  it("全テーブルの全行（ID・内容・件数）と auth.users が元と一致する", async () => {
    const restored = await rowSnapshot(dst!);
    expect(Object.keys(restored)).toEqual(Object.keys(sourceRows));
    expect(restored).toEqual(sourceRows);
    expect(sourceRows["public.bank_transactions"]!.length).toBeGreaterThanOrEqual(3);
  });

  it("取込の件数・金額、AI判断（ルール・メモ・過去仕訳・モデルの参照）、人の確認（保留・承認）、ルール・メモの版が一致する", async () => {
    expect(await workflowMoney(dst!)).toEqual(sourceMoney);
    expect(sourceMoney).toEqual([
      { status: "approved", direction: "income", n: 1, s: "330000" },
      { status: "new", direction: "expense", n: 1, s: "1000" },
      { status: "on_hold", direction: "expense", n: 1, s: "9020" },
    ]);
    const restored = await histories(dst!);
    expect(restored).toEqual(sourceHistories);
    expect(restored.reviews.map((r) => r.action).sort()).toEqual(["approve", "hold"]);
    const withRefs = restored.decisions.find((d) => d.id === decisionIds.hold);
    expect(withRefs).toMatchObject({ model: "synthetic-model", prompt_version: "synthetic-prompt-v0", rule_versions_used: [{ rule_id: SEED_RULE, version: 1 }] });
    expect(withRefs!.past_entry_ids).toHaveLength(1);
    expect(restored.ruleVersions.filter((v) => v.rule_id === NEW_RULE).map((v) => v.version)).toEqual([1, 2]);
    expect(restored.noteVersions.filter((v) => v.note_id === NEW_NOTE).map((v) => v.version)).toEqual([1, 2]);
  });
});

describe.skipIf(!enabled)("復元後の RLS・権限・追記専用（元と同一で、ロール別に実際に効く）", () => {
  it("RLS の有効化・ポリシー・ACL・権限・トリガー・制約・関数・既定権限が元と一致し、public の全テーブルで RLS が有効", async () => {
    const restored = await structure(dst!);
    expect(restored).toEqual(sourceStructure);
    const tables = restored.relations.filter((r) => r.relkind === "r");
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.filter((t) => !t.relrowsecurity).map((t) => t.relname)).toEqual([]);
    // 追記専用のログは、service_role も UPDATE / DELETE / TRUNCATE できない。匿名は何も読めない
    for (const row of restored.privileges) {
      if (row.relname === "ai_decisions" || row.relname === "human_reviews" || row.relname === "execution_logs") {
        if (row.rolname === "anon") expect(row.allowed, `anon ${row.priv} ${row.relname}`).toBe(false);
        if (["UPDATE", "DELETE", "TRUNCATE"].includes(row.priv)) expect(row.allowed, `${row.rolname} ${row.priv} ${row.relname}`).toBe(false);
      }
    }
  });

  it("匿名は読めず、担当者は担当顧客の行だけ見え、担当外の顧客は見えない", async () => {
    for (const table of ["bank_transactions", "ai_decisions", "human_reviews"]) {
      expect((await expectFailure(dst!, "anon", `select count(*) from public.${table}`)).code).toBe("42501");
    }
    const customers = await inTx(dst!, "staff", () => dst!.query<{ id: string }>("select id from public.customers order by id"));
    expect(customers.rows.map((r) => r.id)).toEqual([CUSTOMER_A]);
    expect(customers.rows.map((r) => r.id)).not.toContain(CUSTOMER_B);
    const seen = await inTx(dst!, "staff", () => dst!.query<{ customer_id: string }>("select distinct customer_id from public.bank_transactions"));
    expect(seen.rows.map((r) => r.customer_id)).toEqual([CUSTOMER_A]);
    // 他人の名前では確認を記録できない（RLS の with check）
    const forged = await expectFailure(dst!, "staff", "insert into public.human_reviews (customer_id, ai_decision_id, action, reviewer_id) values ($1, $2, 'hold', $3)", [
      CUSTOMER_A,
      decisionIds.hold,
      ADMIN_ID,
    ]);
    expect(forged.code).toBe("42501");
  });

  it("判断ログ・確認ログは、担当者・service_role の変更が拒否され、所有者でも更新・削除・TRUNCATE が追記専用のトリガーで止まる", async () => {
    for (const actor of ["staff", "service"] as const) {
      expect((await expectFailure(dst!, actor, "update public.ai_decisions set confidence = 'low'")).code).toBe("42501");
      expect((await expectFailure(dst!, actor, "delete from public.human_reviews")).code).toBe("42501");
    }
    for (const sql of ["update public.ai_decisions set confidence = 'low'", "delete from public.human_reviews", "update public.journal_rule_versions set priority = 1", "delete from public.customer_note_versions"]) {
      expect((await expectFailure(dst!, "owner", sql)).message).toMatch(/append-only/);
    }
    expect((await expectFailure(dst!, "owner", "truncate public.ai_decisions cascade")).message).toMatch(/append-only/);
    // 承認・修正の確認がない実行は記録できない（保留の確認を指す実行ログはトリガーで拒否）
    const holdReview = await dst!.query<{ id: string }>("select id from public.human_reviews where action = 'hold' limit 1");
    const execution = await expectFailure(
      dst!,
      "owner",
      "insert into public.execution_logs (customer_id, human_review_id, target, status, error) values ($1, $2, 'freee_deal', 'failed', 'x')",
      [CUSTOMER_A, holdReview.rows[0]!.id],
    );
    expect(execution.message).toMatch(/requires an approve or correct/);
    expect(await rowSnapshot(dst!)).toEqual(sourceRows);
  });
});

describe.skipIf(!enabled)("復元後の次の書込み（ID の衝突なし・既存の行は保持）", () => {
  it("取込・AI判断・人の確認・ルールとメモの版が、既存の ID と衝突せずに通る。再取込は読み飛ばされ、重複 ID・版は拒否される", async () => {
    const sourceIds = new Set(Object.values(sourceRows).flatMap((rows) => rows.map((r) => (JSON.parse(r) as { id?: string }).id).filter((id): id is string => !!id)));

    const fresh = await importRows(dst!, "backup-after-restore.csv", [
      { txn_date: "2026-11-01", amount: 700, direction: "expense", description: "SAMPLE AFTER RESTORE A", balance: 5000, dedupe_key: "bkp-new-1" },
      { txn_date: "2026-11-02", amount: 1200, direction: "income", description: "SAMPLE AFTER RESTORE B", balance: 6200, dedupe_key: "bkp-new-2" },
    ]);
    expect(fresh).toMatchObject({ inserted_count: 2, skipped_duplicate_count: 0 });
    expect(sourceIds.has(fresh.import_id)).toBe(false);
    // 復元前の取込と同じ内容の再取込は、二重に計上しない
    const replay = await importRows(dst!, "backup-fixture-replay.csv", WORKFLOW_ROWS);
    expect(replay).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 3 });

    // 復元後に取り込んだ明細（復元前の行ではない）に判断を記録し、保留を確認する。復元前の明細の状態は変えない
    const newTxn = await dst!.query<{ id: string }>("select id from public.bank_transactions where customer_id = $1 and dedupe_key = 'bkp-new-1'", [CUSTOMER_A]);
    expect(newTxn.rows).toHaveLength(1);
    const decisionId = await recordDecision(dst!, newTxn.rows[0]!.id);
    expect(sourceIds.has(decisionId)).toBe(false);
    const review = await inTx(dst!, "staff", () => dst!.query<{ id: string }>("select public.record_human_review($1, 'hold', null, '復元後の保留', 2, false) as id", [decisionId]));
    expect(sourceIds.has(review.rows[0]!.id)).toBe(false);

    // 版: 次の版は通り、同じ版の重複と同じ依頼 ID の再作成は 23505
    await dst!.query(
      `insert into public.journal_rule_versions (rule_id, version, customer_id, priority, status, source, cond_partner_key, cond_direction, account_item_id, tax_code, created_by)
       values ($1, 3, $2, 30, 'proposed', 'staff', 'サンプルツウシン', 'expense', 101, 21, $3)`,
      [NEW_RULE, CUSTOMER_A, STAFF_ID],
    );
    const dupVersion = await expectFailure(
      dst!,
      "owner",
      `insert into public.journal_rule_versions (rule_id, version, customer_id, priority, status, source, cond_partner_key, cond_direction, account_item_id, tax_code, created_by)
       values ($1, 3, $2, 31, 'proposed', 'staff', 'サンプルツウシン', 'expense', 101, 21, $3)`,
      [NEW_RULE, CUSTOMER_A, STAFF_ID],
    );
    expect(dupVersion.code).toBe("23505");
    const dupRule = await expectFailure(dst!, "staff", "select public.create_rule_from_past_candidate($1, $2, 'サンプルツウシン', 'expense', 101, 21, 50)", [CUSTOMER_A, NEW_RULE]);
    expect(dupRule.code).toBe("23505");
    await inTx(dst!, "staff", () => dst!.query("select public.create_rule_from_past_candidate($1, $2, 'サンプルツウシン', 'expense', 101, 21, 50)", [CUSTOMER_A, AFTER_RULE]));

    // メモも同じ: 復元前の版 1・2 の次の版 3 が通り、同じ版の重複と同じ依頼 ID の再作成は 23505
    const insertNoteVersion = `insert into public.customer_note_versions (note_id, version, customer_id, status, title, body, created_by)
       values ($1, 3, $2, 'inactive', '合成メモ', $3, $4)`;
    await dst!.query(insertNoteVersion, [NEW_NOTE, CUSTOMER_A, "復元後の本文（合成）", STAFF_ID]);
    const dupNoteVersion = await expectFailure(dst!, "owner", insertNoteVersion, [NEW_NOTE, CUSTOMER_A, "重複する版（合成）", STAFF_ID]);
    expect(dupNoteVersion.code).toBe("23505");
    const dupNote = await expectFailure(dst!, "staff", "select public.create_customer_note($1, $2, '合成メモ', '重複する依頼（合成）')", [CUSTOMER_A, NEW_NOTE]);
    expect(dupNote.code).toBe("23505");

    // 復元前の行は 1 行も変わらず残り、元のデータベースは変わっていない
    const afterNotes = (await histories(dst!)).noteVersions.filter((v) => v.note_id === NEW_NOTE).map((v) => v.version);
    expect(afterNotes).toEqual([1, 2, 3]);
    const after = await rowSnapshot(dst!);
    for (const [table, rows] of Object.entries(sourceRows)) {
      const kept = new Set(after[table]);
      expect(rows.filter((r) => !kept.has(r)), `${table}: 復元前の行が変わった・消えた`).toEqual([]);
    }
    expect(after["public.ai_decisions"]!.length).toBe(sourceRows["public.ai_decisions"]!.length + 1);
    expect(after["public.human_reviews"]!.length).toBe(sourceRows["public.human_reviews"]!.length + 1);
    expect(await rowSnapshot(src!)).toEqual(sourceRows);
  });
});
