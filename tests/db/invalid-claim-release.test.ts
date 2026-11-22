import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JournalAi } from "@/lib/ai/client";
import { runProposalJob } from "@/lib/proposals/run";
import { supabaseProposalStore } from "@/lib/proposals/store";
import { applyShim, createDisposableDatabase, noop, openClient, validateBaseUrl, type DisposableDatabase } from "./disposable-db";
import { CUSTOMER_A, WALLET_A } from "./helpers";

/**
 * 不正な貸出し行の返却の DB 結合テスト。期待の記録: docs/reviews/2026-11-06-invalid-claim-release.md
 *
 * 本物: supabaseProposalStore、runProposalJob、本物の PostgreSQL 関数 claim_pending_proposal_batch / release_proposal_claims（service_role で実行）、
 *       本物の表と制約。全マイグレーションと seed を適用した、このファイル専用の使い捨て DB を使う。制約は緩めない。
 * 代役: SupabaseClient は rpc 2 種（claim_pending_proposal_batch / release_proposal_claims）だけを pg の接続で答える狭い偽物。
 *       それ以外の rpc と from(...) は即座に投げる。値は必ずパラメータで渡す。bigint の金額は ::text で文字列のまま渡し、丸めを入れない。
 *       AI は呼ばれたら失敗する代役（claim の解析が文脈の読込より前に失敗するので、AI にも文脈にも届かない）。
 * 本物のトランザクション: 各 RPC は自分の接続で begin → set local role service_role → 実行 → commit する（ロールバックしない）。
 *       コミットされるのはこの DB 専用の合成の明細・貸出しだけで、AI の判断は作らない（ai_decisions は追記専用なので、作らないことを確認する）。
 *
 * 限界: HTTP・PostgREST は通らない。PostgREST は bigint を JSON の数値で返すため 9007199254740993 は 9007199254740992 に丸められてから届く
 *       （それでも安全な整数でないので同じく拒否される）。ここで試すのは文字列として届く場合。競合は pg_stat_activity の観測で重なりを確認するが、
 *       他の接続を止めたり終了させたりはしない。
 */

const DB_PREFIX = "mvp_claim_release_test_";
const TODAY = "2026-11-06";
const UNSAFE = "9007199254740993";
const NORMAL_AMOUNT = "9020";
const BLOCK_WAIT_MS = 5_000;
const TEST_TIMEOUT_MS = 60_000;

const IMPORT_ID = "96000000-0000-4000-8000-0000000000a1";
const T1 = "96000000-0000-4000-8000-000000000001"; // 最初に借りられる（日付が最も早い）
const T3 = "96000000-0000-4000-8000-000000000003";
const T2 = "96000000-0000-4000-8000-000000000002";
const MY_TXNS = [T1, T2, T3];
const OWNER_1 = "a6000000-0000-4000-8000-0000000000a1"; // テスト対象のストアの owner
const OWNER_2 = "a6000000-0000-4000-8000-0000000000a2";
const OWNER_OTHER = "a6000000-0000-4000-8000-0000000000a3";

type SeedTxn = { id: string; date: string; amount: string };
const DATE_OF: Record<string, string> = { [T1]: "2026-10-30", [T3]: "2026-10-31", [T2]: "2026-11-01" };
const seedTxn = (id: string, amount: string): SeedTxn => ({ id, date: DATE_OF[id]!, amount });

let disposable: DisposableDatabase | undefined;
let admin: Client; // 所有者のロール・自動コミット。準備と観測だけに使う
let storeConn: Client; // テスト対象のストアが使う接続
let otherConn: Client; // 別の実行（別の owner）や競合の相手が使う接続

beforeAll(async () => {
  const base = validateBaseUrl();
  disposable = await createDisposableDatabase(base, DB_PREFIX);
  try {
    admin = await openClient(disposable.url, "claim-release-admin");
    await applyShim(admin, readFileSync(join(process.cwd(), "tests/db/supabase-shim.sql"), "utf8"));
    for (const dir of ["supabase/migrations", "supabase/seed"]) {
      for (const name of readdirSync(join(process.cwd(), dir)).filter((n) => n.endsWith(".sql")).sort()) {
        await admin.query(readFileSync(join(process.cwd(), dir, name), "utf8"));
      }
    }
    // seed の未判定が借りられないよう、このファイルの DB でだけ保留に退避する
    await admin.query("update public.bank_transactions set status = 'on_hold' where status = 'new'");
    await admin.query(
      `insert into public.statement_imports (id, customer_id, wallet_id, source, row_count, inserted_count)
       values ($1, $2, $3, 'csv', 3, 3)`,
      [IMPORT_ID, CUSTOMER_A, WALLET_A],
    );
    storeConn = await openClient(disposable.url, "claim-release-store");
    otherConn = await openClient(disposable.url, "claim-release-other");
  } catch (error) {
    await Promise.all([admin, storeConn, otherConn].map((c) => c?.end().catch(noop)));
    await disposable.drop();
    throw error;
  }
}, 180_000);

afterAll(async () => {
  try {
    // 未確定のトランザクションが残っていても、自分の接続だけを閉じる（他の接続は止めない）
    for (const c of [storeConn, otherConn]) await c?.query("rollback").catch(noop);
    await Promise.all([admin, storeConn, otherConn].map((c) => c?.end().catch(noop)));
  } finally {
    await disposable?.drop(); // 失敗は握りつぶさない
  }
}, 60_000);

/** テストごとに、このファイルが作った合成の明細と貸出しだけを消して作り直す（ai_decisions は作らないので消せる） */
async function seedTxns(txns: SeedTxn[]): Promise<void> {
  await admin.query("delete from public.proposal_leases");
  await admin.query("delete from public.bank_transactions where id = any($1::uuid[])", [MY_TXNS]);
  await admin.query("update public.proposal_scan_cursor set last_txn_date = null, last_id = null");
  for (const t of txns) {
    await admin.query(
      `insert into public.bank_transactions (id, customer_id, wallet_id, import_id, txn_date, amount, direction, description, dedupe_key)
       values ($1, $2, $3, $4, $5, $6, 'expense', 'ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ', $7)`,
      [t.id, CUSTOMER_A, WALLET_A, IMPORT_ID, t.date, t.amount, `claim-release-${t.id}`],
    );
  }
}

beforeEach(async () => {
  // 前のテストが失敗して未確定のトランザクションを残していても、次のテストに持ち越さない
  for (const c of [storeConn, otherConn]) await c.query("rollback").catch(noop);
});

// ---------------------------------------------------------------------------
// 狭い SQL アダプタ（SupabaseClient の偽物）
// ---------------------------------------------------------------------------

type PgResult = { data: unknown; error: { message: string } | null };

/** 1 回の RPC を自分の接続で begin → service_role → 実行 → commit する。失敗したらロールバックしてエラーを返す */
async function serviceRpc(conn: Client, sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; error: { message: string } | null }> {
  await conn.query("begin");
  try {
    await conn.query("set local role service_role");
    const res = await conn.query<Record<string, unknown>>(sql, params);
    await conn.query("commit");
    return { rows: res.rows, error: null };
  } catch (error) {
    await conn.query("rollback").catch(noop);
    return { rows: [], error: { message: error instanceof Error ? error.message : String(error) } };
  }
}

const CLAIM_SQL = `select c.id, c.customer_id, c.wallet_id, to_char(c.txn_date, 'YYYY-MM-DD') as txn_date, c.amount::text as amount, c.direction, c.description
                   from public.claim_pending_proposal_batch($1::integer, $2::uuid, $3::integer) c`;
const RELEASE_SQL = "select public.release_proposal_claims($1::uuid, $2::uuid[]) as v";

function onlyKeys(args: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(args).sort().join(",");
  const expected = [...keys].sort().join(",");
  if (actual !== expected) throw new Error(`rpc arguments are not allowlisted: ${actual} (expected ${expected})`);
}

type ReleaseCall = { owner: unknown; ids: unknown; deleted: unknown };

/**
 * beforeRelease は、ストアが返却を呼んでから返却の SQL を実行するまでの間に走る（claim が確定した後・返却の前に、DB を変えるための割り込み）。
 * 返却の呼出しの引数と DB の応答は releases に記録する。
 */
function fakeSupabase(conn: Client, hooks: { beforeRelease?: () => Promise<void> } = {}): { supabase: SupabaseClient; releases: ReleaseCall[]; names: string[] } {
  const releases: ReleaseCall[] = [];
  const names: string[] = [];
  const fake = {
    rpc: async (name: string, args: Record<string, unknown>): Promise<PgResult> => {
      names.push(name);
      switch (name) {
        case "claim_pending_proposal_batch": {
          onlyKeys(args, ["p_limit", "p_owner", "p_lease_seconds"]);
          const res = await serviceRpc(conn, CLAIM_SQL, [args["p_limit"], args["p_owner"], args["p_lease_seconds"]]);
          return res.error ? { data: null, error: res.error } : { data: res.rows, error: null };
        }
        case "release_proposal_claims": {
          onlyKeys(args, ["p_owner", "p_ids"]);
          await hooks.beforeRelease?.();
          const res = await serviceRpc(conn, RELEASE_SQL, [args["p_owner"], args["p_ids"]]);
          const deleted = res.rows[0]?.["v"] ?? null;
          releases.push({ owner: args["p_owner"], ids: args["p_ids"], deleted });
          return res.error ? { data: null, error: res.error } : { data: deleted, error: null };
        }
        default:
          throw new Error(`rpc is not allowlisted: ${name}`);
      }
    },
    from: (table: string) => {
      throw new Error(`from(${table}) is not allowlisted (the claim must fail before any context is read)`);
    },
  };
  return { supabase: fake as unknown as SupabaseClient, releases, names };
}

const neverCalledAi = () =>
  vi.fn(async () => {
    throw new Error("AI must not be called");
  }) as unknown as JournalAi & ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// 観測
// ---------------------------------------------------------------------------

type LeaseRow = { bank_transaction_id: string; owner: string; lease_expires_at: string; unexpired: boolean };

async function leases(): Promise<LeaseRow[]> {
  const res = await admin.query<LeaseRow>(
    `select bank_transaction_id, owner, lease_expires_at::text as lease_expires_at, lease_expires_at > now() as unexpired
     from public.proposal_leases where bank_transaction_id = any($1::uuid[]) order by bank_transaction_id`,
    [MY_TXNS],
  );
  return res.rows;
}

/** 明細が new のままで、AI の判断が 1 件も無い */
async function expectNoDecisionAndStillNew(ids: string[]): Promise<void> {
  const decisions = await admin.query<{ n: number }>("select count(*)::int as n from public.ai_decisions where bank_transaction_id = any($1::uuid[])", [ids]);
  expect(decisions.rows[0]!.n).toBe(0);
  const statuses = await admin.query<{ id: string; status: string }>("select id, status from public.bank_transactions where id = any($1::uuid[]) order by id", [ids]);
  expect(statuses.rows.every((r) => r.status === "new")).toBe(true);
}

async function insertUnrelatedLease(txnId: string): Promise<LeaseRow> {
  await admin.query(
    "insert into public.proposal_leases (bank_transaction_id, owner, lease_expires_at) values ($1, $2, now() + interval '1 hour')",
    [txnId, OWNER_OTHER],
  );
  const row = (await leases()).find((l) => l.bank_transaction_id === txnId);
  if (!row) throw new Error("the unrelated lease was not created");
  expect(row).toMatchObject({ owner: OWNER_OTHER, unexpired: true });
  return row;
}

/** 完了を待たずに開始した操作を追跡する（未処理の rejection を作らない） */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
function track<T>(promise: Promise<T>): { settled: () => boolean; outcome: Promise<Outcome<T>> } {
  let settled = false;
  const outcome = promise
    .then(
      (value): Outcome<T> => ({ ok: true, value }),
      (error: unknown): Outcome<T> => ({ ok: false, error }),
    )
    .then((o) => {
      settled = true;
      return o;
    });
  return { settled: () => settled, outcome };
}

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

async function backendPid(conn: Client): Promise<number> {
  return (await conn.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
}

/** blocked の接続が blocker の接続の確定を待つ（Lock 待ち）状態を、最大 BLOCK_WAIT_MS だけ pg_stat_activity で観測する。待ち種別を返す */
async function waitUntilBlocked(blockedPid: number, blockerPid: number, op: { settled: () => boolean }): Promise<string> {
  const deadline = Date.now() + BLOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const res = await admin.query<{ wait_event_type: string | null; wait_event: string | null; blockers: number[] }>(
      "select wait_event_type, wait_event, pg_blocking_pids(pid) as blockers from pg_stat_activity where pid = $1",
      [blockedPid],
    );
    const row = res.rows[0];
    if (row && row.wait_event_type === "Lock" && row.blockers.includes(blockerPid)) return row.wait_event ?? "";
    if (op.settled()) throw new Error("the release finished without waiting for the second owner (no overlap was observed)");
    await delay(25);
  }
  throw new Error(`no lock wait was observed within ${BLOCK_WAIT_MS} ms`);
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe("claim の返り値が不正なとき、ストアは自分の貸出しだけを本物の SQL で返す", () => {
  it(
    "runProposalJob: 不正な金額 9007199254740993 の貸出しを自分の owner で返す。無関係な他の owner の貸出しは残り、AI も判断の記録も無い",
    async () => {
      await seedTxns([seedTxn(T1, UNSAFE), seedTxn(T2, NORMAL_AMOUNT)]);
      const unrelated = await insertUnrelatedLease(T2);
      expect((await admin.query<{ amount: string }>("select amount::text as amount from public.bank_transactions where id = $1", [T1])).rows[0]!.amount).toBe(UNSAFE);
      const { supabase, releases, names } = fakeSupabase(storeConn);
      const ai = neverCalledAi();

      await expect(runProposalJob({ store: supabaseProposalStore(supabase, OWNER_1), ai, today: TODAY }, 2)).rejects.toThrow(/amount/);

      expect(ai).toHaveBeenCalledTimes(0);
      expect(names).toEqual(["claim_pending_proposal_batch", "release_proposal_claims"]);
      expect(releases).toEqual([{ owner: OWNER_1, ids: [T1], deleted: 1 }]);
      expect(await leases()).toEqual([unrelated]); // 自分の貸出しは 0 件、他の owner の貸出しは変わらない
      await expectNoDecisionAndStillNew([T1, T2]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "1 行でも不正なら、同じ配列で借りた正常な行も返す（呼出し側には 1 行も渡っていない）。他の owner の貸出しは残る",
    async () => {
      await seedTxns([seedTxn(T1, UNSAFE), seedTxn(T3, NORMAL_AMOUNT), seedTxn(T2, NORMAL_AMOUNT)]);
      const unrelated = await insertUnrelatedLease(T2);
      const { supabase, releases } = fakeSupabase(storeConn);

      await expect(supabaseProposalStore(supabase, OWNER_1).claimPendingBatch(5)).rejects.toThrow(/amount/);

      expect(releases).toHaveLength(1);
      expect(releases[0]).toMatchObject({ owner: OWNER_1, deleted: 2 });
      expect([...(releases[0]!.ids as string[])].sort()).toEqual([T1, T3]);
      expect(await leases()).toEqual([unrelated]);
      await expectNoDecisionAndStillNew([T1, T3, T2]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "返却の前に別の owner が確定して借り直していたら、返却は 0 件で、その owner の貸出しを消さない（SQL の owner 条件）",
    async () => {
      await seedTxns([seedTxn(T1, UNSAFE)]);
      const { supabase, releases } = fakeSupabase(storeConn, {
        beforeRelease: async () => {
          // 自分の貸出しが確定した後、期限切れにして、別の owner が借りてコミットする
          await admin.query("update public.proposal_leases set lease_expires_at = now() - interval '1 second' where bank_transaction_id = $1 and owner = $2", [T1, OWNER_1]);
          const second = await serviceRpc(otherConn, CLAIM_SQL, [1, OWNER_2, 600]);
          if (second.error) throw new Error(second.error.message);
          expect(second.rows.map((r) => r["id"])).toEqual([T1]);
        },
      });

      await expect(supabaseProposalStore(supabase, OWNER_1).claimPendingBatch(1)).rejects.toThrow(/amount/);

      expect(releases).toEqual([{ owner: OWNER_1, ids: [T1], deleted: 0 }]);
      expect(await leases()).toMatchObject([{ bank_transaction_id: T1, owner: OWNER_2, unexpired: true }]);
      await expectNoDecisionAndStillNew([T1]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "実際の 2 接続の競合: 別の owner が借り直して行ロックを保持している間、返却はロックを待ち、相手の確定後に 0 件で終わる。相手の貸出しは残る",
    async () => {
      await seedTxns([seedTxn(T1, UNSAFE)]);
      const storePid = await backendPid(storeConn);
      const otherPid = await backendPid(otherConn);
      let holding: { resolve: () => void; reject: (e: unknown) => void } | undefined;
      const secondHolds = new Promise<void>((resolve, reject) => {
        holding = { resolve, reject };
      });
      secondHolds.catch(noop); // 待つ前に拒否されても未処理にしない
      const { supabase, releases } = fakeSupabase(storeConn, {
        beforeRelease: async () => {
          try {
            // 自分の貸出しが確定した後に期限切れにし、別の owner が借り直す。その行ロックを、コミットせずに保持する
            await admin.query("update public.proposal_leases set lease_expires_at = now() - interval '1 second' where bank_transaction_id = $1 and owner = $2", [T1, OWNER_1]);
            await otherConn.query("begin");
            await otherConn.query("set local role service_role");
            const claimed = await otherConn.query<{ id: string }>(CLAIM_SQL, [1, OWNER_2, 600]);
            expect(claimed.rows.map((r) => r.id)).toEqual([T1]);
            holding?.resolve();
          } catch (error) {
            holding?.reject(error);
            throw error;
          }
        },
      });

      const op = track(supabaseProposalStore(supabase, OWNER_1).claimPendingBatch(1));
      let secondCommitted = false;
      try {
        await within(secondHolds, "the second owner to hold the lease row lock", 10_000);
        // 返却がこのあと自分の接続で始まり、別の owner の未確定の更新を待つことを観測する
        const waitEvent = await waitUntilBlocked(storePid, otherPid, op);
        expect(waitEvent).toBe("transactionid");
        expect(op.settled()).toBe(false);

        await otherConn.query("commit");
        secondCommitted = true;
        const outcome = await within(op.outcome, "the invalid claim to settle after the second owner committed", 15_000);
        expect(outcome.ok).toBe(false);
        expect(!outcome.ok && String((outcome.error as Error).message)).toMatch(/amount/);
      } finally {
        // 自分の接続だけを片付ける。他の接続を止めたり終了させたりしない。相手を先に終えれば、待っている返却も終わる
        if (!secondCommitted) await otherConn.query("rollback").catch(noop);
        await within(op.outcome, "the invalid claim to settle during cleanup", 15_000).catch(noop);
        await storeConn.query("rollback").catch(noop);
      }

      expect(releases).toEqual([{ owner: OWNER_1, ids: [T1], deleted: 0 }]);
      expect(await leases()).toMatchObject([{ bank_transaction_id: T1, owner: OWNER_2, unexpired: true }]);
      await expectNoDecisionAndStillNew([T1]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "回復: 返却のあと金額を直せば、別の owner がすぐ借りられる（期限 600 秒を待たない）。AI は不要",
    async () => {
      await seedTxns([seedTxn(T1, UNSAFE)]);
      const first = fakeSupabase(storeConn);

      await expect(supabaseProposalStore(first.supabase, OWNER_1).claimPendingBatch(1)).rejects.toThrow(/amount/);
      expect(first.releases).toEqual([{ owner: OWNER_1, ids: [T1], deleted: 1 }]);
      expect(await leases()).toEqual([]);

      await admin.query("update public.bank_transactions set amount = $2 where id = $1", [T1, NORMAL_AMOUNT]);
      const second = fakeSupabase(otherConn);
      const claimed = await supabaseProposalStore(second.supabase, OWNER_2).claimPendingBatch(1);

      expect(claimed.map((t) => [t.id, t.amount])).toEqual([[T1, Number(NORMAL_AMOUNT)]]);
      expect(second.releases).toEqual([]);
      expect(await leases()).toMatchObject([{ bank_transaction_id: T1, owner: OWNER_2, unexpired: true }]);
      await expectNoDecisionAndStillNew([T1]);
    },
    TEST_TIMEOUT_MS,
  );
});
