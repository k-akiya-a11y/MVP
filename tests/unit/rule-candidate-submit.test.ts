import { describe, expect, it } from "vitest";
import { CREATE_UNKNOWN_MESSAGE } from "@/lib/rules/candidate-schema";
import { createRuleFromCandidate } from "@/lib/rules/candidate-submit";
import { CID, fail, ok, OTHER_CID, SECRET } from "../fixtures/rule-editor";
import {
  candidateScenario,
  entry,
  mastersWithTaxZero,
  REQUEST_ID,
  rpcClient,
  stableEntries,
  validCreateInput,
  writes,
} from "../fixtures/rule-candidate";

// 合成テスト: 実 DB・RLS・RPC 本体は通らない（tests/db/rule-create.test.ts が実 Postgres で確認する）
describe("候補からの新規ルール作成（サーバー側）", () => {
  it("RPC を正確な7つの引数で1回だけ呼ぶ。有効・作成者・作成元・版は送らず、テーブルへ直接書かない", async () => {
    const { client, calls, rpcCalls, getUser } = rpcClient(candidateScenario());
    const result = await createRuleFromCandidate(client, validCreateInput());
    expect(result).toMatchObject({ ok: true, ruleId: REQUEST_ID });
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(rpcCalls).toEqual([
      {
        fn: "create_rule_from_past_candidate",
        args: {
          p_customer_id: CID,
          p_rule_id: REQUEST_ID,
          p_partner_key: "ACME",
          p_direction: "expense",
          p_account_item_id: 100,
          p_tax_code: 10,
          p_priority: 100,
        },
      },
    ]);
    expect(writes(calls)).toHaveLength(0);
    expect(JSON.stringify(rpcCalls)).not.toMatch(/active|created_by|source|status|version/);
  });

  it("成功の文言は提案中であることと、スナップショットの限界を伝える", async () => {
    const { client } = rpcClient(candidateScenario());
    const r = await createRuleFromCandidate(client, validCreateInput());
    expect(r.message).toContain("提案中");
    expect(r.message).toContain("まだ有効ではなく");
    expect(r.message).toContain("変わらないことを示すものではありません");
  });

  it("選んだ税区分 0 がマスタにあれば 0 のまま渡す", async () => {
    const { client, rpcCalls } = rpcClient(candidateScenario({ masters: mastersWithTaxZero() }));
    expect(await createRuleFromCandidate(client, validCreateInput({ taxCode: 0 }))).toMatchObject({ ok: true });
    expect(rpcCalls[0]!.args.p_tax_code).toBe(0);
  });

  it("税区分 0 がマスタにない場合は、0 でも通さない（既定値や推測で補わない）", async () => {
    const { client, rpcCalls } = rpcClient(candidateScenario());
    expect(await createRuleFromCandidate(client, validCreateInput({ taxCode: 0 }))).toMatchObject({ ok: false, outcome: "not_saved", code: "master" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("1件だけの候補も保存できる（警告は画面の役割）", async () => {
    const { client } = rpcClient(candidateScenario({ entries: [entry("p1")] }));
    expect(await createRuleFromCandidate(client, validCreateInput())).toMatchObject({ ok: true });
  });

  it("同じ依頼IDで作った入力は同じ引数になる（依頼IDは勝手に変えない）", async () => {
    const a = rpcClient(candidateScenario());
    const b = rpcClient(candidateScenario());
    await createRuleFromCandidate(a.client, validCreateInput());
    await createRuleFromCandidate(b.client, validCreateInput());
    expect(a.rpcCalls[0]).toEqual(b.rpcCalls[0]);
  });

  it("不正な入力・余計な項目は DB にも RPC にも触れずに拒否する", async () => {
    for (const o of [{ status: "active" }, { createdBy: OTHER_CID }, { taxCode: null }, { priority: "" }, { partnerKey: " " }, { accountItemId: 0 }]) {
      const { client, calls, rpcCalls, getUser } = rpcClient(candidateScenario());
      const r = await createRuleFromCandidate(client, validCreateInput(o));
      expect(r, JSON.stringify(o)).toMatchObject({ ok: false, outcome: "not_saved", code: "invalid" });
      expect(calls).toHaveLength(0);
      expect(rpcCalls).toHaveLength(0);
      expect(getUser).not.toHaveBeenCalled();
    }
  });

  it("未ログイン・ログイン確認の例外では読込も RPC もしない", async () => {
    const none = rpcClient(candidateScenario(), undefined, { user: null });
    expect(await createRuleFromCandidate(none.client, validCreateInput())).toMatchObject({ code: "unauthenticated" });
    expect(none.calls).toHaveLength(0);
    expect(none.rpcCalls).toHaveLength(0);
    const thrown = rpcClient(candidateScenario(), undefined, { getUserThrows: true });
    const r = await createRuleFromCandidate(thrown.client, validCreateInput());
    expect(r).toMatchObject({ outcome: "not_saved", code: "unavailable" });
    expect(JSON.stringify(r)).not.toContain("sk-secret");
    expect(thrown.rpcCalls).toHaveLength(0);
  });

  it("顧客が見えない（他の担当の顧客・偽装した顧客ID）ときは RPC を呼ばない", async () => {
    const { client, rpcCalls } = rpcClient(candidateScenario({ customer: null }));
    expect(await createRuleFromCandidate(client, validCreateInput({ customerId: OTHER_CID }))).toMatchObject({ code: "not_found" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("他の顧客の過去仕訳が混ざる読込は保存せず固定文で返す", async () => {
    const { client, rpcCalls } = rpcClient(candidateScenario({ entries: [entry("x", { customer_id: OTHER_CID })] }));
    const r = await createRuleFromCandidate(client, validCreateInput());
    expect(r).toMatchObject({ outcome: "not_saved", code: "unavailable" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("候補が変わった・科目が複数・キーなし・向き違い・別科目の入力は stale で RPC を呼ばない", async () => {
    const scenarios = [
      candidateScenario({ entries: [...stableEntries(), entry("p3", { account_item_id: 200 })] }),
      candidateScenario({ entries: stableEntries().map((e) => ({ ...e, partner_key: null })) }),
      candidateScenario({ entries: [] }),
    ];
    for (const s of scenarios) {
      const { client, rpcCalls } = rpcClient(s);
      expect(await createRuleFromCandidate(client, validCreateInput())).toMatchObject({ outcome: "not_saved", code: "stale" });
      expect(rpcCalls).toHaveLength(0);
    }
    for (const o of [{ accountItemId: 200 }, { direction: "income" }, { partnerKey: "ACME " }]) {
      const { client, rpcCalls } = rpcClient(candidateScenario());
      expect(await createRuleFromCandidate(client, validCreateInput(o)), JSON.stringify(o)).toMatchObject({ code: "stale" });
      expect(rpcCalls).toHaveLength(0);
    }
  });

  it("科目や税区分が有効なマスタにないときは master で RPC を呼ばない", async () => {
    const accountMissing = rpcClient(candidateScenario({ masters: mastersWithTaxZero().filter((m) => m.freee_id !== 100) }));
    expect(await createRuleFromCandidate(accountMissing.client, validCreateInput())).toMatchObject({ code: "master" });
    const taxMissing = rpcClient(candidateScenario());
    expect(await createRuleFromCandidate(taxMissing.client, validCreateInput({ taxCode: 999 }))).toMatchObject({ code: "master" });
    expect(accountMissing.rpcCalls).toHaveLength(0);
    expect(taxMissing.rpcCalls).toHaveLength(0);
  });

  it("DB が拒否したことが確かなエラーは not_saved。重複(23505)は conflict で、再試行しない", async () => {
    const table: [string, string][] = [
      ["23505", "conflict"],
      ["42501", "denied"],
      ["P0001", "rejected"],
      ["22023", "rejected"],
      ["23503", "rejected"],
    ];
    for (const [pg, code] of table) {
      const { client, rpcMock } = rpcClient(candidateScenario(), () => fail(SECRET, pg));
      const r = await createRuleFromCandidate(client, validCreateInput());
      expect(r, pg).toMatchObject({ ok: false, outcome: "not_saved", code });
      expect(JSON.stringify(r)).not.toContain("sk-secret");
      expect(rpcMock).toHaveBeenCalledTimes(1);
    }
  });

  it("通信失敗・コードのないエラー・応答の欠落や不一致は unknown（失敗とは言い切らず、再送しない）", async () => {
    const handlers: (() => ReturnType<typeof ok> | Promise<never>)[] = [
      () => Promise.reject(new Error(SECRET)),
      () => fail(SECRET),
      () => fail("fetch failed", "PGRST301"),
      () => ok(null),
      () => ok("99999999-9999-4999-8999-999999999999"),
      () => ok({ id: REQUEST_ID }),
    ];
    for (const h of handlers) {
      const { client, rpcMock } = rpcClient(candidateScenario(), h);
      const r = await createRuleFromCandidate(client, validCreateInput());
      expect(r).toEqual({ ok: false, outcome: "unknown", code: "unknown", message: CREATE_UNKNOWN_MESSAGE });
      expect(r.message).not.toContain("保存していません");
      expect(rpcMock).toHaveBeenCalledTimes(1);
    }
  });
});
