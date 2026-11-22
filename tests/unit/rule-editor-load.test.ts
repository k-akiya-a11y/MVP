import { describe, expect, it } from "vitest";
import { loadRuleEditor, RULE_LOAD_FAILED_MESSAGE, RuleEditorLoadError } from "@/lib/rules/editor-load";
import { PAGE_SIZE } from "@/lib/supabase/fetch-all";
import { CID, eqs, fail, fakeClient, has, masterRows, OTHER_CID, ok, page, RID, SECRET, versionRow, walletRows, type Call, type Reply } from "../fixtures/rule-editor";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Tables = { customer?: unknown; parents?: unknown[]; versions?: unknown[]; masters?: unknown[]; wallets?: unknown[] };

function loaderScenario(t: Tables = {}) {
  return (c: Call): Reply => {
    switch (c.table) {
      case "customers":
        return ok(t.customer === undefined ? { id: CID, name: "テスト商事" } : t.customer);
      case "journal_rules":
        return page(t.parents ?? [{ id: RID, customer_id: CID }], c);
      case "current_journal_rules":
        return page(t.versions ?? [versionRow()], c);
      case "freee_masters":
        return page(t.masters ?? masterRows(), c);
      case "wallets":
        return page(t.wallets ?? walletRows(), c);
      default:
        return fail(`unexpected table ${c.table}`);
    }
  };
}

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("rejected を期待したが成功した");
};

describe("既存ルール編集画面の読込", () => {
  it("顧客が見えない（権限外・存在しない）ときは、ルールを読まずに null", async () => {
    const { client, calls } = fakeClient(loaderScenario({ customer: null }));
    expect(await loadRuleEditor(client, CID)).toBeNull();
    expect(calls.map((c) => c.table)).toEqual(["customers"]);
  });

  it("顧客IDの形式が不正なら DB に触れずに null", async () => {
    const { client, calls } = fakeClient(loaderScenario());
    expect(await loadRuleEditor(client, "not-a-uuid")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("現在の版・有効なマスタ・口座を読み、保存されている値をそのまま返す", async () => {
    const { client } = fakeClient(loaderScenario());
    const data = await loadRuleEditor(client, CID);
    expect(data?.customer).toEqual({ id: CID, name: "テスト商事" });
    expect(data?.rules).toEqual([
      {
        ruleId: RID,
        version: 3,
        status: "proposed",
        source: "past_entries",
        priority: 100,
        cond: { partnerKey: "ACME", descriptionKeyword: null, amountMin: 1000, amountMax: 50000, walletId: null, direction: "expense" },
        action: { accountItemId: 100, taxCode: 10, partnerId: null, itemId: null, sectionId: null, tagIds: [], descriptionTemplate: null },
        validFrom: null,
        validTo: null,
        createdAt: "2026-10-01T00:00:00+00:00",
      },
    ]);
    expect(data?.masters.account_item).toEqual([
      { id: 100, name: "消耗品費" },
      { id: 200, name: "通信費" },
    ]);
    expect(data?.masters.tax).toEqual([{ id: 10, name: "課税仕入10%" }]);
    expect(data?.wallets).toEqual([{ id: "33333333-3333-4333-8333-333333333333", name: "普通預金", kind: "bank_account" }]);
  });

  it("すべての読込を顧客で絞り、マスタは有効なものだけを一意な順序で読む", async () => {
    const { client, calls } = fakeClient(loaderScenario());
    await loadRuleEditor(client, CID);
    for (const c of calls) expect(eqs(c), c.table).toContain(`${c.table === "customers" ? "id" : "customer_id"}=${CID}`);
    const masters = calls.find((c) => c.table === "freee_masters")!;
    expect(eqs(masters)).toContain("available=true");
    expect(masters.ops.filter((o) => o.op === "order").map((o) => o.args[0])).toEqual(["kind", "freee_id"]);
    expect(calls.find((c) => c.table === "current_journal_rules")!.ops.some((o) => o.op === "order" && o.args[0] === "rule_id")).toBe(true);
  });

  it("1ページ(1000行)を超えるルール・マスタ・口座もすべて読む", async () => {
    const n = PAGE_SIZE + 250;
    const parents = Array.from({ length: n }, (_, i) => ({ id: uuid(i + 1), customer_id: CID }));
    const versions = parents.map((p, i) => versionRow({ rule_id: p.id, priority: i }));
    const masters = Array.from({ length: n }, (_, i) => ({ customer_id: CID, kind: "partner", freee_id: i + 1, name: `取引先${i + 1}`, available: true }));
    const wallets = Array.from({ length: n }, (_, i) => ({ id: uuid(5000 + i), customer_id: CID, name: `口座${i}`, kind: "bank_account" }));
    const { client, calls } = fakeClient(loaderScenario({ parents, versions, masters, wallets }));
    const data = await loadRuleEditor(client, CID);
    expect(data?.rules).toHaveLength(n);
    expect(data?.masters.partner).toHaveLength(n);
    expect(data?.wallets).toHaveLength(n);
    expect(calls.filter((c) => c.table === "freee_masters")).toHaveLength(3); // 1000 + 250 + 空ページ
  });

  it("bigint が文字列で返っても数値にし、null を0にしない", async () => {
    const { client } = fakeClient(
      loaderScenario({ versions: [versionRow({ cond_amount_min: "0", cond_amount_max: null, account_item_id: "100", partner_id: "7", tag_ids: ["5", 6] })] }),
    );
    const rule = (await loadRuleEditor(client, CID))!.rules[0]!;
    expect(rule.cond.amountMin).toBe(0);
    expect(rule.cond.amountMax).toBeNull();
    expect(rule.action).toMatchObject({ accountItemId: 100, partnerId: 7, tagIds: [5, 6] });
  });

  it("優先順位 → 作成日時 → ID の順に並べる", async () => {
    const ids = [uuid(3), uuid(2), uuid(1)];
    const parents = ids.map((id) => ({ id, customer_id: CID }));
    const versions = [
      versionRow({ rule_id: uuid(3), priority: 5, created_at: "2026-10-03T00:00:00+00:00" }),
      versionRow({ rule_id: uuid(2), priority: 5, created_at: "2026-10-02T00:00:00+00:00" }),
      versionRow({ rule_id: uuid(1), priority: 1, created_at: "2026-10-09T00:00:00+00:00" }),
    ];
    const { client } = fakeClient(loaderScenario({ parents, versions }));
    expect((await loadRuleEditor(client, CID))!.rules.map((r) => r.ruleId)).toEqual([uuid(1), uuid(2), uuid(3)]);
  });

  it("ルールが0件でも失敗とは区別して空で返す", async () => {
    const { client } = fakeClient(loaderScenario({ parents: [], versions: [] }));
    expect((await loadRuleEditor(client, CID))?.rules).toEqual([]);
  });

  it("読込の失敗はすべて固定文のエラーにし、内部の情報を含めない", async () => {
    const failing = ["customers", "journal_rules", "current_journal_rules", "freee_masters", "wallets"];
    for (const table of failing) {
      const base = loaderScenario();
      const { client } = fakeClient((c) => (c.table === table ? fail(SECRET, "XX000") : base(c)));
      const error = await rejection(loadRuleEditor(client, CID));
      expect(error, table).toBeInstanceOf(RuleEditorLoadError);
      expect((error as Error).message).toBe(RULE_LOAD_FAILED_MESSAGE);
      expect(JSON.stringify(error)).not.toContain("sk-secret");
      expect((error as Error).stack ?? "").not.toContain("sk-secret");
    }
  });

  it("通信の例外・形式の不正も固定文のエラー", async () => {
    const thrown = fakeClient(() => {
      throw new Error(SECRET);
    });
    expect((await rejection(loadRuleEditor(thrown.client, CID))) as Error).toMatchObject({ message: RULE_LOAD_FAILED_MESSAGE });

    for (const tables of [
      { versions: [versionRow({ status: "deleted" })] },
      { versions: [versionRow({ priority: "100" })] },
      { versions: [{ rule_id: RID }] },
      { masters: [{ customer_id: CID, kind: "unknown", freee_id: 1, name: "x", available: true }] },
      { masters: [{ customer_id: CID, kind: "partner", freee_id: 1, name: "x", available: false }] },
      { masters: [{ customer_id: CID, kind: "partner", freee_id: 1, name: "x" }] },
      { wallets: "not an array" },
    ]) {
      const { client } = fakeClient(loaderScenario(tables as Tables));
      expect(await rejection(loadRuleEditor(client, CID)), JSON.stringify(tables)).toBeInstanceOf(RuleEditorLoadError);
    }
  });

  it("他の顧客の行が混ざっていたら、一部を捨てて続けずに失敗にする", async () => {
    const cases: Tables[] = [
      { customer: { id: OTHER_CID, name: "他社" } },
      { parents: [{ id: RID, customer_id: OTHER_CID }] },
      { versions: [versionRow({ customer_id: OTHER_CID })] },
      { masters: [...masterRows(), ...masterRows(OTHER_CID)] },
      { wallets: walletRows(OTHER_CID) },
    ];
    for (const t of cases) {
      const { client } = fakeClient(loaderScenario(t));
      expect(await rejection(loadRuleEditor(client, CID)), JSON.stringify(t)).toBeInstanceOf(RuleEditorLoadError);
    }
  });

  it("親が見えない版・同じルールの現在の版が複数ある場合は失敗にする", async () => {
    const orphan = fakeClient(loaderScenario({ versions: [versionRow({ rule_id: uuid(9) })] }));
    expect(await rejection(loadRuleEditor(orphan.client, CID))).toBeInstanceOf(RuleEditorLoadError);
    const dup = fakeClient(loaderScenario({ versions: [versionRow(), versionRow({ version: 4 })] }));
    expect(await rejection(loadRuleEditor(dup.client, CID))).toBeInstanceOf(RuleEditorLoadError);
  });

  it("読取専用: insert / update / delete を呼ばない", async () => {
    const { client, calls } = fakeClient(loaderScenario());
    await loadRuleEditor(client, CID);
    expect(calls.some((c) => has(c, "insert") || has(c, "update") || has(c, "delete") || has(c, "upsert"))).toBe(false);
  });
});
