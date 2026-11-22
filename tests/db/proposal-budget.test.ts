import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AiCallResult, JournalAi } from "@/lib/ai/client";
import type { AiJournalOutput } from "@/lib/ai/schema";
import { JOURNAL_MODEL, JOURNAL_PROMPT_VERSION } from "@/lib/ai/version";
import { runProposalJob } from "@/lib/proposals/run";
import type { ProposalStore } from "@/lib/proposals/store";
import type { BankTransaction } from "@/lib/proposals/types";
import { sampleContext } from "../fixtures/proposal-context";
import { applyShim, createDisposableDatabase, noop, openClient, validateBaseUrl, type DisposableDatabase } from "./disposable-db";
import { CUSTOMER_A, WALLET_A } from "./helpers";

/**
 * runProposalJob の「confirmClaim（所有の確認）の後に予算を再確認する」修正の DB 結合テスト。
 * 実行記録: docs/reviews/2026-11-06-proposal-budget-after-claim.md（使い捨てのローカル PostgreSQL 17.11 で 3 件成功）。
 *
 * 何を本物にし、何を代役にしているか（読み違えないための明記）:
 *   - 本物: runProposalJob、本物の PostgreSQL 関数 claim_pending_proposal_batch / renew_proposal_claim /
 *     release_proposal_claims / record_claimed_ai_decision（service_role で実行）、本物の表（bank_transactions・proposal_leases・ai_decisions）。
 *   - 代役: ProposalStore。supabaseProposalStore（PostgREST / supabase-js）は通らず、pg の接続から SQL で関数を直接呼ぶ狭いアダプタ。
 *     つまり PostgREST の引数の受け渡し・応答の形・HTTP は検証していない（それは単体テストの担当）。
 *   - 代役: 時計。注入の now() を「実際に await した renew_proposal_claim が成功した直後」にだけ進める。
 *     これは遅延の注入であって、ネットワークのタイムアウトや実際の遅い往復を再現したものではない。
 *   - AI は mockAI（vi.fn）。実 AI のクライアントは import も生成もしない。顧客の文脈は sampleContext を seed の顧客に結びつけ、
 *     ルールを空にして必ず AI 経路に入るようにする。
 * ai_decisions は追記専用で消せない（明細への外部キーは restrict）ので、各テストは 1 つのトランザクションの中で行い、必ずロールバックする。
 * このファイル専用の使い捨て DB を作り、末尾で削除する。TEST_DATABASE_URL の共有 DB の行は読みも書きもしない。
 */

const DB_PREFIX = "mvp_budget_test_";
const BUDGET_MS = 500;
/**
 * runProposalJob は attempted が batchSize に達すると、次の claim をせず truncated: true にする（本番の意図した挙動）。
 * 明細は 1 件なので、「未判定を使い切って truncated: false・最後の claim が空」を期待する実行は batchSize 2 にする。
 * 予算切れで打ち切られる 1 回目だけは batchSize 1 のまま（打ち切りの理由は予算であり、上限ではないことを区別するため 2 にしても結果は同じ）。
 */
const EXHAUST_BATCH_SIZE = 2;
const TODAY = "2026-11-06";

const IMPORT_ID = "92000000-0000-4000-8000-0000000000a1";
const TXN_ID = "92000000-0000-4000-8000-000000000001";
const OWNER_FIRST = "a2000000-0000-4000-8000-00000000000a";
const OWNER_SECOND = "b2000000-0000-4000-8000-00000000000b";

let disposable: DisposableDatabase | undefined;
let client: Client;

beforeAll(async () => {
  const base = validateBaseUrl();
  disposable = await createDisposableDatabase(base, DB_PREFIX);
  try {
    client = await openClient(disposable.url, "proposal-budget-test");
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

/** 遅延の注入用の時計。進めるのはアダプタだけ（renew が成功した直後） */
function delayClock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => void (t += ms), elapsed: () => t };
}

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

/** service_role として fn を実行し、必ずロールを戻す（テーブル所有者の操作と混ぜない）。トランザクションの中で呼ぶ */
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await client.query("reset role");
  await client.query("set local role service_role");
  let out: T;
  try {
    out = await fn();
  } catch (error) {
    await client.query("reset role").catch(noop); // 失敗でトランザクションが壊れていても元の例外を隠さない
    throw error;
  }
  await client.query("reset role");
  return out;
}

type ClaimRow = { id: string; customer_id: string; wallet_id: string; txn_date: string; amount: string; direction: "income" | "expense"; description: string };

function toTxn(r: ClaimRow): BankTransaction {
  const amount = Number(r.amount);
  if (!Number.isSafeInteger(amount)) throw new Error(`amount is not a safe integer: ${r.amount}`);
  return { id: r.id, customerId: r.customer_id, walletId: r.wallet_id, txnDate: r.txn_date, amount, direction: r.direction, description: r.description };
}

/**
 * 狭い SQL アダプタ（PostgREST を通らない）。owner ごとに 1 つ作る（supabaseProposalStore と同じく、実行ごとに新しい所有者）。
 * confirmClaim は本物の renew_proposal_claim を await し、真だった直後にだけ時計を elapsedAfterRenewMs 進める。
 */
function sqlStore(owner: string, clock: ReturnType<typeof delayClock>, elapsedAfterRenewMs: number, trace: string[]): ProposalStore {
  return {
    async claimPendingBatch(limit) {
      trace.push("claim");
      const res = await asService(() =>
        client.query<ClaimRow>(
          `select id, customer_id, wallet_id, to_char(txn_date, 'YYYY-MM-DD') as txn_date, amount::text as amount, direction, description
           from public.claim_pending_proposal_batch($1, $2, 600)`,
          [limit, owner],
        ),
      );
      return res.rows.map(toTxn);
    },
    async confirmClaim(id) {
      const res = await asService(() => client.query<{ ok: boolean }>("select public.renew_proposal_claim($1, $2, 600) as ok", [owner, id]));
      const ok = res.rows[0]!.ok;
      trace.push(`renew:${ok}`);
      if (ok) clock.advance(elapsedAfterRenewMs); // 実際に await した renew が成功した後にだけ進める
      return ok;
    },
    async releaseClaims(ids) {
      trace.push("release");
      await asService(() => client.query("select public.release_proposal_claims($1, $2::uuid[]) as n", [owner, ids]));
    },
    async loadCustomerContext(customerId) {
      trace.push("load");
      const row = await client.query<{ id: string }>("select id from public.customers where id = $1", [customerId]);
      if (row.rows.length !== 1) throw new Error("the seeded customer is missing");
      const ctx = sampleContext();
      if (ctx.customer.id !== customerId || customerId !== CUSTOMER_A) throw new Error("the sample context is not bound to the seeded customer");
      return {
        ...ctx,
        activeRules: [], // ルールに一致させず、必ず AI（mockAI）の経路に入れる
        // 過去仕訳の ID は ai_decisions.past_entry_ids（uuid[]）に入るので、合成の UUID にする
        pastEntries: ctx.pastEntries.map((p, i) => ({ ...p, id: `93000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}` })),
      };
    },
    async recordDecision(row) {
      trace.push("record");
      const res = await asService(() =>
        client.query<{ id: string }>("select public.record_claimed_ai_decision($1, $2::jsonb) as id", [owner, JSON.stringify(row)]),
      );
      const id = res.rows[0]!.id;
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`unexpected decision id: ${id}`);
      return id;
    },
  };
}

/** 既存の未判定（seed）を保留に退避し、位置を先頭に戻し、貸出しを空にして、合成の明細を 1 件作る。トランザクション内なのでロールバックされる */
async function seedOneTxn(): Promise<void> {
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
     values ($1, $2, $3, $4, '2026-10-30', 165000, 'expense', 'ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ', 'budget-test-1')`,
    [TXN_ID, CUSTOMER_A, WALLET_A, IMPORT_ID],
  );
}

type DbState = { status: string; leases: number; decisions: number; decisionRows: Array<{ customer_id: string; model: string | null; has_ai_output: boolean }> };

async function dbState(): Promise<DbState> {
  await client.query("reset role");
  const status = (await client.query<{ status: string }>("select status from public.bank_transactions where id = $1", [TXN_ID])).rows[0]!.status;
  const leases = (await client.query<{ n: number }>("select count(*)::int as n from public.proposal_leases where bank_transaction_id = $1", [TXN_ID])).rows[0]!.n;
  const rows = await client.query<{ customer_id: string; model: string | null; has_ai_output: boolean }>(
    "select customer_id, model, (ai_output is not null) as has_ai_output from public.ai_decisions where bank_transaction_id = $1",
    [TXN_ID],
  );
  return { status, leases, decisions: rows.rows.length, decisionRows: rows.rows };
}

async function inTx(fn: () => Promise<void>): Promise<void> {
  await client.query("begin");
  try {
    await seedOneTxn();
    await fn();
  } finally {
    await client.query("reset role").catch(noop);
    await client.query("rollback"); // ai_decisions は消せないので、必ずロールバックする
  }
}

const truncatedRun = { processed: 0, attempted: 1, truncated: true, failures: [] as unknown[], byConfidence: { high: 0, medium: 0, low: 0 } };

describe("confirmClaim の後の予算再確認（本物の DB 関数・実 runProposalJob・mockAI）", () => {
  it.each([500, 501])(
    "renew 成功の直後に経過が %d ms（予算 500 ms）なら、AI を呼ばず・判断を記録せず・貸出しを返して打ち切り、別の所有者が（同じ接続・同じトランザクション内の逐次実行で）1 回だけ処理する",
    (elapsed) =>
      inTx(async () => {
        // 1 回目: 所有確認が遅く、予算を使い切る
        const clock1 = delayClock();
        const trace1: string[] = [];
        const ai1 = mockAi();
        const first = await runProposalJob(
          { store: sqlStore(OWNER_FIRST, clock1, elapsed, trace1), ai: ai1, today: TODAY, now: clock1.now, budgetMs: BUDGET_MS },
          1,
        );
        expect(trace1).toEqual(["claim", "load", "renew:true", "release"]); // 時計は本物の renew が真を返した後にだけ進んでいる
        expect(clock1.elapsed()).toBe(elapsed);
        expect(first).toEqual(truncatedRun);
        expect(ai1).toHaveBeenCalledTimes(0);
        expect(await dbState()).toEqual({ status: "new", leases: 0, decisions: 0, decisionRows: [] });

        // 2 回目: 別の所有者・別の実行（時計は予算内）。ただし同じ接続・同じトランザクションの中の逐次実行であり、
        // 独立にコミットされた同時実行ではない。ここで確認するのは「この逐次の流れで同じ明細が 1 回だけ処理された」ことまで
        const clock2 = delayClock();
        const trace2: string[] = [];
        const ai2 = mockAi();
        const second = await runProposalJob(
          { store: sqlStore(OWNER_SECOND, clock2, 0, trace2), ai: ai2, today: TODAY, now: clock2.now, budgetMs: BUDGET_MS },
          EXHAUST_BATCH_SIZE,
        );
        expect(second).toMatchObject({ processed: 1, attempted: 1, truncated: false, failures: [] });
        expect(trace2).toEqual(["claim", "load", "renew:true", "record", "claim"]);
        expect(ai2).toHaveBeenCalledTimes(1);
        expect(await dbState()).toEqual({
          status: "proposed",
          leases: 0,
          decisions: 1,
          decisionRows: [{ customer_id: CUSTOMER_A, model: JOURNAL_MODEL, has_ai_output: true }],
        });

        // 3 回目: もう未判定がないので、AI も記録も増えない（同じ接続・同じトランザクション内での確認であり、一般的な exactly-once の保証ではない）
        const clock3 = delayClock();
        const ai3 = mockAi();
        const third = await runProposalJob(
          { store: sqlStore(OWNER_FIRST, clock3, 0, []), ai: ai3, today: TODAY, now: clock3.now, budgetMs: BUDGET_MS },
          EXHAUST_BATCH_SIZE,
        );
        expect(third).toMatchObject({ processed: 0, attempted: 0, failures: [] });
        expect(ai3).toHaveBeenCalledTimes(0);
        expect((await dbState()).decisions).toBe(1);
      }),
    30_000,
  );

  it("renew 成功の直後でも経過が 499 ms（予算内）なら、従来どおり AI を 1 回呼び、判断を 1 件記録して貸出しを終える", () =>
    inTx(async () => {
      const clock = delayClock();
      const trace: string[] = [];
      const ai = mockAi();
      const result = await runProposalJob(
        { store: sqlStore(OWNER_FIRST, clock, 499, trace), ai, today: TODAY, now: clock.now, budgetMs: BUDGET_MS },
        EXHAUST_BATCH_SIZE,
      );
      expect(clock.elapsed()).toBe(499);
      expect(result).toMatchObject({ processed: 1, attempted: 1, truncated: false, failures: [] });
      expect(trace).toEqual(["claim", "load", "renew:true", "record", "claim"]);
      expect(ai).toHaveBeenCalledTimes(1);
      expect(await dbState()).toEqual({
        status: "proposed",
        leases: 0,
        decisions: 1,
        decisionRows: [{ customer_id: CUSTOMER_A, model: JOURNAL_MODEL, has_ai_output: true }],
      });
    }), 30_000);
});
