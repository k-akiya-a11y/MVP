import { Client } from "pg";

export const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
export const STAFF_ID = "00000000-0000-4000-8000-000000000002";
export const CUSTOMER_A = "10000000-0000-4000-8000-000000000001";
export const CUSTOMER_B = "10000000-0000-4000-8000-000000000002";
export const WALLET_A = "20000000-0000-4000-8000-000000000001";

export async function connect(): Promise<Client> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is required (npm run db:test:local で起動できます)");
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

type Actor = { role: "anon" } | { role: "authenticated"; userId: string } | { role: "service_role" };

/**
 * トランザクション内でロールと JWT の sub を切り替えて fn を実行し、最後に必ずロールバックする。
 * テスト同士がデータを汚さないようにするため。
 */
export async function asActor<T>(client: Client, actor: Actor, fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    if (actor.role === "authenticated") {
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [actor.userId]);
    }
    await client.query(`set local role ${actor.role}`);
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

/** 失敗を期待するクエリ。セーブポイントで包み、トランザクションを壊さない */
export async function expectQueryError(client: Client, sql: string, params: unknown[] = []): Promise<string> {
  await client.query("savepoint expect_error");
  try {
    await client.query(sql, params);
  } catch (error) {
    await client.query("rollback to savepoint expect_error");
    return error instanceof Error ? error.message : String(error);
  }
  await client.query("release savepoint expect_error");
  throw new Error(`expected query to fail: ${sql}`);
}

/** サンプルの明細・AI判断を1件作り、その ID を返す（呼出し側のトランザクション内） */
export async function insertSampleDecision(client: Client): Promise<{ txnId: string; decisionId: string }> {
  const imp = await client.query<{ id: string }>(
    `insert into public.statement_imports (customer_id, wallet_id, source, row_count, inserted_count)
     values ($1, $2, 'csv', 1, 1) returning id`,
    [CUSTOMER_A, WALLET_A],
  );
  const txn = await client.query<{ id: string }>(
    `insert into public.bank_transactions (customer_id, wallet_id, import_id, txn_date, amount, direction, description, dedupe_key)
     values ($1, $2, $3, '2026-10-27', 9020, 'expense', 'ｻﾝﾌﾟﾙﾂｳｼﾝ(ｶ', 'test-1') returning id`,
    [CUSTOMER_A, WALLET_A, imp.rows[0]!.id],
  );
  const decision = await client.query<{ id: string }>(
    `insert into public.ai_decisions (customer_id, bank_transaction_id, transaction_snapshot, proposal, confidence, confidence_breakdown)
     values ($1, $2, '{}', '{"account_item_id": 101, "tax_code": 21}', 'high', '{}') returning id`,
    [CUSTOMER_A, txn.rows[0]!.id],
  );
  return { txnId: txn.rows[0]!.id, decisionId: decision.rows[0]!.id };
}
