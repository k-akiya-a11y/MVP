import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { runProposalJob } from "@/lib/proposals/run";
import { supabaseProposalStore } from "@/lib/proposals/store";
import { MOCK_MODEL, mockJournalAi } from "./mock-journal-ai";

/**
 * 実結合の確認（docs/integration-check.md 段階12）: 検証用の Supabase に対して、候補生成ジョブを偽のモデルで1回動かす。
 * Claude API は呼ばない（偽のモデルは SDK を使わず、ANTHROPIC_API_KEY も実行前に消す）。
 *
 * 実行: VERIFY_PROJECT_REF=<検証用プロジェクトの Reference ID> npm run verify:mock-propose
 * - 接続先とキーは .env.local の NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY（本人が直接入力。チャットに貼らない）
 * - VERIFY_PROJECT_REF が URL の Reference ID と一致しないと止める（取り違えて別のプロジェクトにつながないため）
 * - DB の顧客が架空データ（seed と tests/fixtures/verification）の ID だけでないと止める（本物の顧客がいる DB では動かさない）
 * - 値は表示しない。表示するのは接続先の Reference ID と結果の件数だけ
 */

const FIXTURE_CUSTOMER_IDS = new Set([
  "10000000-0000-4000-8000-000000000001", // サンプル商事株式会社（seed）
  "10000000-0000-4000-8000-000000000002", // テスト工房合同会社（seed）
  "10000000-0000-4000-8000-000000000003", // 検証用商事株式会社（tests/fixtures/verification）
]);

const enabled = Boolean(process.env.VERIFY_PROJECT_REF);

describe.runIf(enabled)("検証用 Supabase で候補生成ジョブを偽のモデルで動かす", () => {
  it("架空データだけの検証用プロジェクトで、Claude API を呼ばずに1回実行する", { timeout: 330_000 }, async () => {
    if (existsSync(".env.local")) process.loadEnvFile(".env.local");
    // 本物の AI に届く経路を残さない
    delete process.env.ANTHROPIC_API_KEY;

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    const match = /^https:\/\/([a-z0-9]+)\.supabase\.co$/.exec(url);
    expect(match, "NEXT_PUBLIC_SUPABASE_URL は https://<Reference ID>.supabase.co の形にしてください").not.toBeNull();
    const ref = match![1];
    expect(ref, "VERIFY_PROJECT_REF が接続先の Reference ID と一致しません").toBe(process.env.VERIFY_PROJECT_REF);
    expect(key, "SUPABASE_SERVICE_ROLE_KEY が設定されていません").not.toBe("");

    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: customers, error } = await client.from("customers").select("id");
    expect(error).toBeNull();
    const unknown = (customers ?? []).filter((c: { id: string }) => !FIXTURE_CUSTOMER_IDS.has(c.id));
    expect(unknown.length, "架空データ以外の顧客があります。本物の顧客がいる DB では実行しません").toBe(0);

    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const result = await runProposalJob({ store: supabaseProposalStore(client), ai: mockJournalAi, today });
    console.log(`接続先: ${ref}`);
    console.log(`モデル: ${MOCK_MODEL}（判断ログの model 列に記録される）`);
    console.log(JSON.stringify(result, null, 2));
    expect(result.failures).toEqual([]);
  });
});

describe.runIf(!enabled)("検証用 Supabase で候補生成ジョブを偽のモデルで動かす", () => {
  it.skip("VERIFY_PROJECT_REF を指定したときだけ実行する", () => undefined);
});
