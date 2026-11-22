import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { supabaseProposalStore } from "@/lib/proposals/store";

const OWNER = "store-owner";
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

type RpcResult = { data: unknown; error: { message: string } | null };
type RpcCall = { name: string; args: Record<string, unknown> };

/** 貸出し RPC の結果と返却 RPC の挙動を指定できる、rpc だけを持つ偽のクライアント。呼出しを順に記録する */
function fakeClient(claim: RpcResult, release: () => Promise<RpcResult> = async () => ({ data: null, error: null })) {
  const calls: RpcCall[] = [];
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return name === "claim_pending_proposal_batch" ? claim : release();
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const row = (id: unknown, overrides: Record<string, unknown> = {}) => ({
  id,
  customer_id: "c1",
  wallet_id: "w1",
  txn_date: "2026-11-05",
  amount: 1000,
  direction: "expense",
  description: "SAMPLE SHOP",
  ...overrides,
});

const ok = (data: unknown): RpcResult => ({ data, error: null });

const releaseCalls = (calls: RpcCall[]) => calls.filter((c) => c.name === "release_proposal_claims");

/** noUncheckedIndexedAccess のもとで [0] を直接読まず、無ければ分かる失敗にする */
function first(calls: RpcCall[]): RpcCall {
  const call = calls[0];
  if (!call) throw new Error("RPC の呼出しが記録されていない");
  return call;
}

const releaseArgs = (calls: RpcCall[]) => first(releaseCalls(calls)).args;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("rejects するはずが成功した");
}

describe("claimPendingBatch: 検証に失敗した貸出し行の返却", () => {
  it("amount が不正で ID が正しい行は、検証エラーを投げ、そのストアの owner と ID で返却する", async () => {
    const { client, calls } = fakeClient(ok([row(ID_A, { amount: "12.5" })]));

    const error = await rejection(supabaseProposalStore(client, OWNER).claimPendingBatch(1));

    expect(error).toBeInstanceOf(ZodError);
    expect(calls.map((c) => c.name)).toEqual(["claim_pending_proposal_batch", "release_proposal_claims"]);
    expect(releaseArgs(calls)).toEqual({ p_owner: OWNER, p_ids: [ID_A] });
  });

  it("正常行と不正行が混在するときは、全行の ID を初出順に重複なしで 1 回だけ返却する", async () => {
    const { client, calls } = fakeClient(
      ok([row(ID_A), row(ID_B, { amount: null }), row(ID_A, { amount: "abc" }), row(ID_C), row(ID_B)]),
    );

    const error = await rejection(supabaseProposalStore(client, OWNER).claimPendingBatch(5));

    expect(error).toBeInstanceOf(ZodError);
    expect(releaseCalls(calls)).toHaveLength(1);
    expect(releaseArgs(calls)).toEqual({ p_owner: OWNER, p_ids: [ID_A, ID_B, ID_C] });
  });

  it("UUID でない ID・ID の欠落・null の行は返却せず、広い返却もしない", async () => {
    const { client, calls } = fakeClient(
      ok([row("not-a-uuid", { amount: "x" }), row(undefined, { amount: "x" }), row(null), row(123), null]),
    );

    const error = await rejection(supabaseProposalStore(client, OWNER).claimPendingBatch(5));

    expect(error).toBeInstanceOf(ZodError);
    expect(calls.map((c) => c.name)).toEqual(["claim_pending_proposal_batch"]);
  });

  it("特定できない行が混ざるときは、正しい UUID の ID だけを返却する", async () => {
    const { client, calls } = fakeClient(ok([row("not-a-uuid"), row(ID_A, { amount: "x" }), null, row(ID_B)]));

    await rejection(supabaseProposalStore(client, OWNER).claimPendingBatch(5));

    expect(releaseCalls(calls)).toHaveLength(1);
    expect(releaseArgs(calls)).toEqual({ p_owner: OWNER, p_ids: [ID_A, ID_B] });
  });

  it.each([
    ["オブジェクト", { id: ID_A }],
    ["文字列", ID_A],
    ["数値", 1],
  ])("結果が配列でない（%s）ときは、返却しない", async (_label, data) => {
    const { client, calls } = fakeClient(ok(data));

    const error = await rejection(supabaseProposalStore(client, OWNER).claimPendingBatch(1));

    expect(error).toBeInstanceOf(ZodError);
    expect(calls.map((c) => c.name)).toEqual(["claim_pending_proposal_batch"]);
  });

  it("応答の行にある owner は信用せず、常にストアの owner で返却する", async () => {
    const { client, calls } = fakeClient(
      ok([row(ID_A, { amount: "x", owner: "other-owner", claimed_by: "other-owner", p_owner: "other-owner" })]),
    );

    await rejection(supabaseProposalStore(client, OWNER).claimPendingBatch(1));

    expect(releaseCalls(calls)).toHaveLength(1);
    expect(releaseArgs(calls)).toEqual({ p_owner: OWNER, p_ids: [ID_A] });
  });

  it("返却がエラーを返しても、元の検証エラーを投げる（返却のエラーに置き換えない）", async () => {
    const { client, calls } = fakeClient(ok([row(ID_A, { amount: "x" })]), async () => ({
      data: null,
      error: { message: "release-failed-marker" },
    }));

    const error = await rejection(supabaseProposalStore(client, OWNER).claimPendingBatch(1));

    expect(releaseCalls(calls)).toHaveLength(1);
    expect(error).toBeInstanceOf(ZodError);
    expect(String((error as Error).message)).not.toContain("release-failed-marker");
  });

  it("返却が例外を投げても、元の検証エラーを投げる（成功を装わず、例外に置き換えない）", async () => {
    const releaseFailure = new Error("release-threw-marker");
    const { client, calls } = fakeClient(ok([row(ID_A, { amount: "x" })]), async () => {
      throw releaseFailure;
    });

    const error = await rejection(supabaseProposalStore(client, OWNER).claimPendingBatch(1));

    expect(releaseCalls(calls)).toHaveLength(1);
    expect(error).not.toBe(releaseFailure);
    expect(error).toBeInstanceOf(ZodError);
    expect(String((error as Error).message)).not.toContain("release-threw-marker");
  });

  it("返却が拒否されても（Promise の reject）、元の検証エラーを投げる", async () => {
    const { client, calls } = fakeClient(ok([row(ID_A, { amount: "x" })]), () => Promise.reject("release-rejected-marker"));

    const error = await rejection(supabaseProposalStore(client, OWNER).claimPendingBatch(1));

    expect(releaseCalls(calls)).toHaveLength(1);
    expect(error).not.toBe("release-rejected-marker");
    expect(error).toBeInstanceOf(ZodError);
  });

  it("正常な行だけの配列は、明細を返し、返却の RPC を呼ばない", async () => {
    const { client, calls } = fakeClient(ok([row(ID_A, { amount: "1500" }), row(ID_B)]));

    const txns = await supabaseProposalStore(client, OWNER).claimPendingBatch(2);

    expect(txns.map((t) => [t.id, t.amount])).toEqual([
      [ID_A, 1500],
      [ID_B, 1000],
    ]);
    expect(calls.map((c) => c.name)).toEqual(["claim_pending_proposal_batch"]);
    expect(first(calls).args).toMatchObject({ p_limit: 2, p_owner: OWNER });
  });

  it("貸出し RPC 自体がエラーのときは、そのエラーを投げ、推測の返却をしない", async () => {
    const { client, calls } = fakeClient({ data: [row(ID_A, { amount: "x" })], error: { message: "claim-failed" } });

    const error = await rejection(supabaseProposalStore(client, OWNER).claimPendingBatch(1));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ZodError);
    expect((error as Error).message).toContain("claim-failed");
    expect(calls.map((c) => c.name)).toEqual(["claim_pending_proposal_batch"]);
  });

  it("貸出し RPC の結果が null のときも、返却しない", async () => {
    const { client, calls } = fakeClient(ok(null));

    await rejection(supabaseProposalStore(client, OWNER).claimPendingBatch(1));

    expect(calls.map((c) => c.name)).toEqual(["claim_pending_proposal_batch"]);
  });
});
