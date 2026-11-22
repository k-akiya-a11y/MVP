import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { claudeJournalAi, type AiCallResult } from "@/lib/ai/client";
import { JOURNAL_PROMPT_VERSION } from "@/lib/ai/version";
import { toAiDecisionRow } from "@/lib/audit/decision-log";
import { proposeForTransaction } from "@/lib/proposals/propose";
import type { BankTransaction } from "@/lib/proposals/types";
import { sampleContext } from "../fixtures/proposal-context";
import { applyShim, createDisposableDatabase, noop, openClient, validateBaseUrl, type DisposableDatabase } from "./disposable-db";
import { CUSTOMER_A, WALLET_A } from "./helpers";

/**
 * AI の回答に NUL（U+0000）がある場合の DB 結合テスト（tests/unit/ai-nul-output.test.ts の単体テストの DB 側）。
 * 実行結果: Codex が使い捨ての PostgreSQL 17.11 に対して実行し、9 件成功だった。詳細は
 * docs/reviews/2026-11-06-ai-nul-output.md の「追記 2026-11-06: DB 結合テストの検証」を参照。
 *
 * 何を本物にし、何を代役にしているか（読み違えないための明記）:
 *   - 本物: claudeJournalAi（JSON.parse・zod 検証・NUL の拒否）、proposeForTransaction、toAiDecisionRow、
 *     本物の PostgreSQL 関数 claim_pending_proposal_batch / record_claimed_ai_decision（その中から record_ai_decision）を service_role で実行、
 *     本物の表（bank_transactions・proposal_leases・ai_decisions・human_reviews・execution_logs）。
 *   - 代役: Anthropic クライアント。messages.create だけを持つ偽物（vi.fn）を claudeJournalAi に渡す。
 *     実 SDK のクライアントは生成しない（new Anthropic() の既定引数は評価されない）。ネットワークも認証情報も使わない。
 *   - 経由しないもの: PostgREST（supabase-js の rpc・引数の受け渡し・HTTP）、実 AI、ブラウザ、runProposalJob、supabaseProposalStore。
 *     pg の接続から SQL で関数を直接呼ぶだけ（アダプタは持たない）。それらは別のテストの担当で、ここでは検証していない。
 * 顧客の文脈は sampleContext（ルールは空にして必ず AI 経路に入れる）。顧客・口座は seed の CUSTOMER_A・WALLET_A と同じ値で、
 * 過去仕訳の ID は ai_decisions.past_entry_ids（uuid[]）に入るので合成の UUID に置き換える。明細は本物の UUID で作り、
 * claim_pending_proposal_batch が返した行から BankTransaction を作るので、文脈と DB の明細は一致する。
 * ai_decisions は追記専用で消せない（明細への外部キーは restrict）ので、各テストは 1 つのトランザクションの中で行い、必ずロールバックする。
 * このファイル専用の使い捨て DB を作り、末尾で削除する。TEST_DATABASE_URL の共有 DB の行は読みも書きもしない。
 */

const DB_PREFIX = "mvp_ainul_test_";
const NUL = "\u0000";
const MODEL = "claude-test-model-snapshot";
const LEAK = "漏れてはいけない架空の摘要XYZ";
const LEAK_HEAD = LEAK.slice(0, 4);
/** claudeJournalAi が NUL を断るときの固定の不明点（回答の本文や NUL は載らない） */
const SAFE_UNKNOWN = "AI の回答を使えません（invalid: 回答の文字列に NUL 文字が含まれています）";

const IMPORT_ID = "94000000-0000-4000-8000-0000000000a1";
const TXN_ID = "94000000-0000-4000-8000-000000000001";
const OWNER = "a4000000-0000-4000-8000-00000000000a";

let disposable: DisposableDatabase | undefined;
let client: Client;

beforeAll(async () => {
  const base = validateBaseUrl();
  disposable = await createDisposableDatabase(base, DB_PREFIX);
  try {
    client = await openClient(disposable.url, "ai-nul-output-test");
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

const base = {
  decision: "proposal",
  account_item_id: 105,
  tax_code: 21,
  partner_id: 302,
  item_id: null,
  section_id: 401,
  tag_ids: [] as number[],
  description: "11月分 家賃",
  reason: "過去と同じ",
  unknowns: [] as string[],
  fixed_asset_possible: false,
  officer_or_personal: false,
};
const cannotDecide = { ...base, decision: "cannot_decide", account_item_id: null, tax_code: null, partner_id: null, section_id: null };
type Output = Record<string, unknown>;

const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 };
/** 単体テストと同じ使用量から計算される費用（100万分の1ドル） */
const COST_MICROS = 4600;

/** messages.create だけを持つ偽のクライアント。JSON.stringify は NUL を \u0000 の6文字に書くので、JSON としては正しい回答になる */
function fakeClient(output: Output) {
  const create = vi.fn(async () => ({
    model: MODEL,
    stop_reason: "end_turn",
    stop_details: null,
    usage: USAGE,
    content: [{ type: "text", text: JSON.stringify(output) }],
  }));
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

/** service_role として fn を実行し、必ずロールを戻す（テーブル所有者の操作と混ぜない）。トランザクションの中で呼ぶ */
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await client.query("reset role");
  await client.query("set local role service_role");
  try {
    return await fn();
  } finally {
    await client.query("reset role").catch(noop); // 失敗でトランザクションが壊れていても元の例外を隠さない
  }
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
     values ($1, $2, $3, $4, '2026-10-30', 165000, 'expense', 'ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ', 'ai-nul-test-1')`,
    [TXN_ID, CUSTOMER_A, WALLET_A, IMPORT_ID],
  );
}

type ClaimRow = { id: string; customer_id: string; wallet_id: string; txn_date: string; amount: string; direction: "income" | "expense"; description: string };

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    await seedOneTxn();
    return await fn();
  } finally {
    await client.query("reset role").catch(noop);
    await client.query("rollback"); // ai_decisions は消せないので、必ずロールバックする
  }
}

type Counts = { reviews: number; executions: number };
async function counts(): Promise<Counts> {
  await client.query("reset role");
  const res = await client.query<{ reviews: number; executions: number }>(
    "select (select count(*)::int from public.human_reviews) as reviews, (select count(*)::int from public.execution_logs) as executions",
  );
  return res.rows[0]!;
}

type Persisted = {
  confidence: string;
  proposal: Record<string, unknown> | null;
  ai_output: Record<string, unknown> | null;
  ai_reason: string | null;
  ai_unknowns: string[];
  model: string | null;
  prompt_version: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd_micros: number | null;
  past_entry_ids: string[];
  transaction_snapshot: Record<string, unknown>;
  dump: string;
};

type Outcome = {
  aiCalls: number;
  create: ReturnType<typeof fakeClient>["create"];
  result: AiCallResult;
  decisionId: string;
  decisions: Persisted[];
  txnStatus: string;
  leases: number;
  reviewsAdded: number;
  executionsAdded: number;
  rowPastIds: string[];
};

/**
 * 偽の messages.create → 本物の claudeJournalAi → proposeForTransaction → toAiDecisionRow → 本物の
 * claim_pending_proposal_batch で借りた明細に record_claimed_ai_decision（service_role）。トランザクションの中で呼ぶ。
 */
async function runPipeline(output: Output): Promise<Outcome> {
  const before = await counts();

  const claimed = await asService(() =>
    client.query<ClaimRow>(
      `select id, customer_id, wallet_id, to_char(txn_date, 'YYYY-MM-DD') as txn_date, amount::text as amount, direction, description
       from public.claim_pending_proposal_batch(1, $1, 600)`,
      [OWNER],
    ),
  );
  expect(claimed.rows.map((r) => r.id)).toEqual([TXN_ID]);
  const r = claimed.rows[0]!;
  const amount = Number(r.amount);
  if (!Number.isSafeInteger(amount)) throw new Error(`amount is not a safe integer: ${r.amount}`);
  const txn: BankTransaction = { id: r.id, customerId: r.customer_id, walletId: r.wallet_id, txnDate: r.txn_date, amount, direction: r.direction, description: r.description };

  // 文脈は DB の顧客・口座・明細と一致させる
  const sample = sampleContext();
  const customer = await client.query("select id from public.customers where id = $1", [txn.customerId]);
  if (customer.rows.length !== 1 || sample.customer.id !== txn.customerId || txn.customerId !== CUSTOMER_A) {
    throw new Error("the sample context is not bound to the seeded customer");
  }
  if (txn.walletId !== WALLET_A || !sample.walletNames.has(txn.walletId)) throw new Error("the sample context is not bound to the seeded wallet");
  const ctx = {
    ...sample,
    activeRules: [], // ルールに一致させず、必ず AI の経路に入れる
    pastEntries: sample.pastEntries.map((p, i) => ({ ...p, id: `93000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}` })),
  };

  const { client: fake, create } = fakeClient(output);
  const real = claudeJournalAi(fake);
  const results: AiCallResult[] = [];
  const draft = await proposeForTransaction(ctx, txn, async (prompt) => {
    const res = await real(prompt);
    results.push(res);
    return res;
  });
  const row = toAiDecisionRow(draft);

  const recorded = await asService(() =>
    client.query<{ id: string }>("select public.record_claimed_ai_decision($1, $2::jsonb) as id", [OWNER, JSON.stringify(row)]),
  );
  const decisionId = recorded.rows[0]!.id;
  expect(decisionId).toMatch(/^[0-9a-f-]{36}$/);

  await client.query("reset role");
  const persisted = await client.query<Persisted>(
    `select d.confidence, d.proposal, d.ai_output, d.ai_reason, d.ai_unknowns, d.model, d.prompt_version,
            d.input_tokens, d.output_tokens, d.cache_read_tokens, d.cache_write_tokens, d.cost_usd_micros::int as cost_usd_micros,
            d.past_entry_ids, d.transaction_snapshot, row_to_json(d)::text as dump
     from public.ai_decisions d where d.bank_transaction_id = $1`,
    [TXN_ID],
  );
  const status = await client.query<{ status: string }>("select status from public.bank_transactions where id = $1", [TXN_ID]);
  const leases = await client.query<{ n: number }>("select count(*)::int as n from public.proposal_leases where bank_transaction_id = $1", [TXN_ID]);
  const after = await counts();

  return {
    aiCalls: results.length,
    create,
    result: results[0]!,
    decisionId,
    decisions: persisted.rows,
    txnStatus: status.rows[0]!.status,
    leases: leases.rows[0]!.n,
    reviewsAdded: after.reviews - before.reviews,
    executionsAdded: after.executions - before.executions,
    rowPastIds: row.past_entry_ids,
  };
}

/** NUL を含む回答は、AI を使えない low の判断として 1 行だけ残り、明細は人の確認待ち（proposed）になる */
function expectSafeLowDecision(o: Outcome): void {
  expect(o.create).toHaveBeenCalledTimes(1);
  expect(o.aiCalls).toBe(1);
  expect(o.result.status).toBe("invalid");
  expect(o.decisions).toHaveLength(1); // 実際の行がちょうど 1 行
  const d = o.decisions[0]!;
  expect(d.confidence).toBe("low");
  expect(d.proposal).toBeNull();
  expect(d.ai_output).toBeNull();
  expect(d.ai_reason).toBeNull();
  expect(d.ai_unknowns).toEqual([SAFE_UNKNOWN]);
  // モデル・プロンプトの版・使用量（費用を含む）は残る
  expect(d.model).toBe(MODEL);
  expect(d.prompt_version).toBe(JOURNAL_PROMPT_VERSION);
  expect(d.input_tokens).toBe(1000);
  expect(d.output_tokens).toBe(200);
  expect(d.cache_read_tokens).toBe(3000);
  expect(d.cache_write_tokens).toBe(0);
  expect(d.cost_usd_micros).toBe(COST_MICROS);
  // 回答の本文は行のどこにも写らない（行全体を JSON にした文字列で確かめる）
  expect(d.dump).not.toContain(LEAK);
  expect(d.dump).not.toContain(LEAK_HEAD);
  expect(d.dump).not.toContain(NUL);
  // 文脈と一致した明細・顧客・口座の写し
  expect(d.transaction_snapshot).toMatchObject({ id: TXN_ID, customerId: CUSTOMER_A, walletId: WALLET_A, walletName: "サンプル銀行 本店 普通" });
  expect(d.past_entry_ids).toEqual(o.rowPastIds);
  // 状態: 人の確認待ちに進むだけ。貸出しは終わり、人の確認も外部への実行も作られない
  expect(o.txnStatus).toBe("proposed");
  expect(o.leases).toBe(0);
  expect(o.reviewsAdded).toBe(0);
  expect(o.executionsAdded).toBe(0);
}

const middleNul = `${LEAK_HEAD}${NUL}${LEAK.slice(4)}`;
const nulCases: Array<{ name: string; output: Output }> = [
  { name: "proposal の description", output: { ...base, description: middleNul } },
  { name: "proposal の reason", output: { ...base, reason: middleNul } },
  { name: "proposal の unknowns", output: { ...base, unknowns: ["正常な不明点", middleNul] } },
  { name: "cannot_decide の description", output: { ...cannotDecide, description: middleNul } },
  { name: "cannot_decide の reason", output: { ...cannotDecide, reason: middleNul } },
  { name: "cannot_decide の unknowns", output: { ...cannotDecide, unknowns: ["正常な不明点", middleNul] } },
];

describe("AI の回答に NUL を含む場合（実 claudeJournalAi → 本物の record_claimed_ai_decision）", () => {
  it.each(nulCases)(
    "$name: 記録が失敗せず、low・提案なし・AI 出力なしの判断が 1 行だけ残り、明細は proposed。正常な不明点の本文も写らない",
    ({ output }) =>
      inTx(async () => {
        const o = await runPipeline(output);
        expectSafeLowDecision(o);
        expect(o.decisions[0]!.dump).not.toContain("正常な不明点");
      }),
    30_000,
  );
});

describe("NUL を含まない回答は従来どおりそのまま残る（実 claudeJournalAi → 本物の record_claimed_ai_decision）", () => {
  it("日本語・改行を含む description / reason / unknowns は一文字も変えずに保存される", () =>
    inTx(async () => {
      const output = {
        ...base,
        description: "11月分\n家賃（本社）",
        reason: "過去6件と同じ。\n取引先は不動産会社",
        unknowns: ["請求書の宛名を確認したい\n（担当者）", "別の不明点"],
      };
      const o = await runPipeline(output);
      expect(o.create).toHaveBeenCalledTimes(1);
      expect(o.result.status).toBe("ok");
      expect(o.decisions).toHaveLength(1);
      const d = o.decisions[0]!;
      expect(d.proposal).toMatchObject({ account_item_id: 105, tax_code: 21, description: output.description });
      expect(d.ai_output).toEqual(output);
      expect(d.ai_reason).toBe(output.reason);
      expect(d.ai_unknowns).toEqual(output.unknowns);
      expect(d.model).toBe(MODEL);
      expect(d.prompt_version).toBe(JOURNAL_PROMPT_VERSION);
      expect(d.cost_usd_micros).toBe(COST_MICROS);
      expect(o.txnStatus).toBe("proposed");
      expect(o.reviewsAdded).toBe(0);
      expect(o.executionsAdded).toBe(0);
    }), 30_000);

  it("文字としての「\\u0000」（バックスラッシュ + u0000 の6文字）は NUL ではないので、受け付けて同じ6文字のまま保存される", () =>
    inTx(async () => {
      const literal = "\\u0000";
      expect(literal).toHaveLength(6);
      const output = { ...base, description: `摘要${literal}`, reason: `理由${literal}`, unknowns: [`不明${literal}`] };
      const o = await runPipeline(output);
      expect(o.result.status).toBe("ok");
      expect(o.decisions).toHaveLength(1);
      const d = o.decisions[0]!;
      expect(d.proposal).toMatchObject({ description: `摘要${literal}` });
      expect(d.ai_output).toEqual(output);
      expect(d.ai_reason).toBe(`理由${literal}`);
      expect(d.ai_unknowns).toEqual([`不明${literal}`]);
      expect(d.ai_reason).toHaveLength(2 + 6);
      expect(d.ai_reason).not.toContain(NUL);
      expect(o.txnStatus).toBe("proposed");
    }), 30_000);

  it("NUL がない cannot_decide は従来どおり ok のまま、提案なしで理由と不明点をそのまま残す", () =>
    inTx(async () => {
      const output = { ...cannotDecide, reason: "判断材料が足りない", unknowns: ["用途が不明"] };
      const o = await runPipeline(output);
      expect(o.result.status).toBe("ok");
      expect(o.decisions).toHaveLength(1);
      const d = o.decisions[0]!;
      expect(d.proposal).toBeNull();
      expect(d.ai_output).toEqual(output);
      expect(d.ai_reason).toBe("判断材料が足りない");
      expect(d.ai_unknowns).toEqual(["用途が不明"]);
      expect(d.model).toBe(MODEL);
      expect(d.cost_usd_micros).toBe(COST_MICROS);
      expect(o.txnStatus).toBe("proposed");
      expect(o.reviewsAdded).toBe(0);
      expect(o.executionsAdded).toBe(0);
    }), 30_000);
});
