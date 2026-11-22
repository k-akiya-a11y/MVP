import { describe, expect, it } from "vitest";
import { submitRuleVersion, UNKNOWN_OUTCOME_MESSAGE } from "@/lib/rules/editor-submit";
import {
  arg,
  CID,
  fail,
  fakeClient,
  has,
  masterRows,
  OTHER_CID,
  ok,
  RID,
  ruleScenario,
  SECRET,
  USER,
  validInput,
  versionRow,
  walletRows,
  WID,
  type Call,
} from "../fixtures/rule-editor";

// 合成テスト: 実 DB・RLS・実際の同時実行は通らない（tests/db は別途、実 Postgres で確認する）
const inserts = (calls: Call[]) => calls.filter((c) => has(c, "insert"));
const writes = (calls: Call[]) => calls.filter((c) => has(c, "insert") || has(c, "update") || has(c, "delete") || has(c, "upsert"));

describe("既存ルールの新しい版の保存", () => {
  it("割当済みの担当者として、版 expected+1 を作成者=ログイン中のユーザー・作成元=staff で追加する（親・既存の版は触らない）", async () => {
    const { client, calls, getUser } = fakeClient(ruleScenario());
    const result = await submitRuleVersion(client, validInput({ status: "active" }));
    expect(result).toMatchObject({ ok: true, ruleId: RID, version: 4, status: "active" });
    expect(getUser).toHaveBeenCalledTimes(1);

    const w = writes(calls);
    expect(w).toHaveLength(1);
    expect(w[0]!.table).toBe("journal_rule_versions");
    expect(w[0]!.ops.map((o) => o.op)).toEqual(["insert", "select", "single"]);
    expect(arg(w[0]!, "insert")).toEqual({
      rule_id: RID,
      version: 4,
      customer_id: CID,
      priority: 100,
      status: "active",
      source: "staff",
      cond_partner_key: "ACME",
      cond_description_keyword: null,
      cond_amount_min: 1000,
      cond_amount_max: 50000,
      cond_wallet_id: null,
      cond_direction: "expense",
      account_item_id: 100,
      tax_code: 10,
      partner_id: null,
      item_id: null,
      section_id: null,
      tag_ids: [],
      description_template: null,
      valid_from: null,
      valid_to: null,
      created_by: USER,
    });
    // 親（journal_rules）には書かない。更新・削除・upsert は一切ない
    expect(calls.some((c) => c.table === "journal_rules" && writes([c]).length > 0)).toBe(false);
    expect(calls.some((c) => has(c, "update") || has(c, "delete") || has(c, "upsert"))).toBe(false);
  });

  it("読込はすべて顧客で絞り、親ルール・現在の版も rule_id と customer_id を明示する", async () => {
    const { client, calls } = fakeClient(ruleScenario());
    await submitRuleVersion(client, validInput());
    const versionsRead = calls.find((c) => c.table === "journal_rule_versions" && !has(c, "insert"))!;
    expect(versionsRead.ops.map((o) => `${o.op}`)).toEqual(["select", "eq", "eq", "order", "limit"]);
    expect(versionsRead.ops.filter((o) => o.op === "eq").map((o) => o.args)).toEqual([["rule_id", RID], ["customer_id", CID]]);
    expect(arg(versionsRead, "order", 1)).toEqual({ ascending: false });
    const parent = calls.find((c) => c.table === "journal_rules")!;
    expect(parent.ops.filter((o) => o.op === "eq").map((o) => o.args)).toEqual([["id", RID], ["customer_id", CID]]);
    for (const table of ["freee_masters", "wallets"]) {
      for (const c of calls.filter((x) => x.table === table)) expect(c.ops.some((o) => o.op === "eq" && o.args[0] === "customer_id" && o.args[1] === CID)).toBe(true);
    }
  });

  it("未ログインなら書込も読込もしない", async () => {
    const { client, calls } = fakeClient(ruleScenario(), { user: null });
    const result = await submitRuleVersion(client, validInput());
    expect(result).toMatchObject({ ok: false, outcome: "not_saved", code: "unauthenticated" });
    expect(calls).toHaveLength(0);
  });

  it("ログイン確認が例外でも保存せず、内部の情報を返さない", async () => {
    const { client, calls } = fakeClient(ruleScenario(), { getUserThrows: true });
    const result = await submitRuleVersion(client, validInput());
    expect(result).toMatchObject({ ok: false, outcome: "not_saved", code: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("sk-secret");
    expect(writes(calls)).toHaveLength(0);
  });

  it("入力の作成者・作成元・版・顧客の上書きは、保存せず拒否する", async () => {
    for (const extra of [{ createdBy: OTHER_CID }, { created_by: OTHER_CID }, { source: "correction_history" }, { version: 99 }, { customer_id: OTHER_CID }]) {
      const { client, calls } = fakeClient(ruleScenario());
      const result = await submitRuleVersion(client, validInput(extra));
      expect(result, JSON.stringify(extra)).toMatchObject({ ok: false, outcome: "not_saved", code: "invalid" });
      expect(calls).toHaveLength(0);
    }
    const { client, calls } = fakeClient(ruleScenario());
    const nested = validInput();
    const result = await submitRuleVersion(client, { ...nested, cond: { ...nested.cond, createdBy: OTHER_CID, customerId: OTHER_CID } });
    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("不正な入力は DB に触れずに拒否する", async () => {
    const bad = [
      validInput({ expectedVersion: 0 }),
      validInput({ priority: 1.5 }),
      validInput({ validFrom: "2023-02-29" }),
      validInput({ cond: { ...validInput().cond, partnerKey: " ", amountMin: null, amountMax: null, direction: null } }),
      validInput({ cond: { ...validInput().cond, amountMin: 5, amountMax: 5 } }),
      null,
      "string",
    ];
    for (const input of bad) {
      const { client, calls } = fakeClient(ruleScenario());
      const result = await submitRuleVersion(client, input);
      expect(result).toMatchObject({ ok: false, outcome: "not_saved", code: "invalid" });
      expect(calls).toHaveLength(0);
    }
  });

  it("見えない顧客・他の顧客の親ルールは保存しない", async () => {
    const hidden = fakeClient(ruleScenario({ customer: null }));
    expect(await submitRuleVersion(hidden.client, validInput())).toMatchObject({ ok: false, code: "not_found" });
    expect(writes(hidden.calls)).toHaveLength(0);

    const noParent = fakeClient(ruleScenario({ parent: null }));
    expect(await submitRuleVersion(noParent.client, validInput())).toMatchObject({ ok: false, code: "not_found" });
    expect(writes(noParent.calls)).toHaveLength(0);

    // 絞り込みを抜けて他の顧客の行が返ってきた場合は、テナント不一致として保存しない
    const foreignParent = fakeClient(ruleScenario({ parent: { id: RID, customer_id: OTHER_CID } }));
    expect(await submitRuleVersion(foreignParent.client, validInput())).toMatchObject({ ok: false, outcome: "not_saved", code: "unavailable" });
    expect(writes(foreignParent.calls)).toHaveLength(0);

    const foreignCustomer = fakeClient(ruleScenario({ customer: { id: OTHER_CID, name: "他社" } }));
    expect(await submitRuleVersion(foreignCustomer.client, validInput())).toMatchObject({ ok: false, code: "unavailable" });
    expect(writes(foreignCustomer.calls)).toHaveLength(0);

    const foreignVersion = fakeClient(ruleScenario({ versions: [versionRow({ customer_id: OTHER_CID })] }));
    expect(await submitRuleVersion(foreignVersion.client, validInput())).toMatchObject({ ok: false, code: "unavailable" });
    expect(writes(foreignVersion.calls)).toHaveLength(0);

    const otherRule = fakeClient(ruleScenario({ versions: [versionRow({ rule_id: "77777777-7777-4777-8777-777777777777" })] }));
    expect(await submitRuleVersion(otherRule.client, validInput())).toMatchObject({ ok: false, code: "unavailable" });
    expect(writes(otherRule.calls)).toHaveLength(0);

    const noVersions = fakeClient(ruleScenario({ versions: [] }));
    expect(await submitRuleVersion(noVersions.client, validInput())).toMatchObject({ ok: false, code: "unavailable" });
    expect(writes(noVersions.calls)).toHaveLength(0);
  });

  it("他の顧客の口座は、有効でも無効化でも保存しない", async () => {
    const input = validInput({ cond: { ...validInput().cond, walletId: WID } });
    for (const status of ["active", "inactive", "proposed"]) {
      const foreignWallet = fakeClient(ruleScenario({ wallets: [] }));
      expect(await submitRuleVersion(foreignWallet.client, { ...input, status }), status).toMatchObject({ ok: false, code: "wallet" });
      expect(writes(foreignWallet.calls)).toHaveLength(0);
      const tenantMix = fakeClient(ruleScenario({ wallets: walletRows(OTHER_CID) }));
      expect(await submitRuleVersion(tenantMix.client, { ...input, status }), status).toMatchObject({ ok: false, code: "unavailable" });
      expect(writes(tenantMix.calls)).toHaveLength(0);
    }
    const own = fakeClient(ruleScenario());
    expect(await submitRuleVersion(own.client, input)).toMatchObject({ ok: true, version: 4 });
    expect((arg(inserts(own.calls)[0]!, "insert") as { cond_wallet_id: string }).cond_wallet_id).toBe(WID);
  });

  it("有効にするときはマスタにない値を拒否し、無効化・提案中は古い科目でも保存できる", async () => {
    const missingAccount = { action: { ...validInput().action, accountItemId: 999 } };
    const active = fakeClient(ruleScenario());
    const rejected = await submitRuleVersion(active.client, validInput({ ...missingAccount, status: "active" }));
    expect(rejected).toMatchObject({ ok: false, outcome: "not_saved", code: "master" });
    expect(rejected.message).toContain("勘定科目 999 はマスタにありません");
    expect(writes(active.calls)).toHaveLength(0);

    for (const status of ["inactive", "proposed"] as const) {
      const { client, calls } = fakeClient(ruleScenario({ masters: [] }));
      const result = await submitRuleVersion(client, validInput({ ...missingAccount, status }));
      expect(result, status).toMatchObject({ ok: true, version: 4, status });
      expect(writes(calls)).toHaveLength(1);
      // 無効化はマスタの読込を必要としない
      expect(calls.some((c) => c.table === "freee_masters")).toBe(false);
    }

    // 有効: 取引先・税区分・メモタグ・マスタ全体が空の場合も拒否する
    for (const action of [
      { ...validInput().action, taxCode: 11 },
      { ...validInput().action, partnerId: 8 },
      { ...validInput().action, tagIds: [5, 6] },
    ]) {
      const { client, calls } = fakeClient(ruleScenario());
      expect(await submitRuleVersion(client, validInput({ action, status: "active" }))).toMatchObject({ ok: false, code: "master" });
      expect(writes(calls)).toHaveLength(0);
    }
    const empty = fakeClient(ruleScenario({ masters: [] }));
    expect(await submitRuleVersion(empty.client, validInput({ status: "active" }))).toMatchObject({ ok: false, code: "master" });
  });

  it("有効化では他の顧客のマスタが混ざっていたら保存しない", async () => {
    const { client, calls } = fakeClient(ruleScenario({ masters: masterRows(OTHER_CID) }));
    expect(await submitRuleVersion(client, validInput({ status: "active" }))).toMatchObject({ ok: false, code: "unavailable" });
    expect(writes(calls)).toHaveLength(0);
  });

  it("有効化では available=false のマスタが返っても保存しない（挿入しない）", async () => {
    for (const available of [false, null, undefined]) {
      const masters = masterRows().map((m) => ({ ...m, available }));
      const { client, calls } = fakeClient(ruleScenario({ masters }));
      expect(await submitRuleVersion(client, validInput({ status: "active" })), String(available)).toMatchObject({ ok: false, code: "unavailable" });
      expect(writes(calls)).toHaveLength(0);
    }
  });

  it("保存済みの長い雛形・条件、遠い未来の日付、100件を超えるタグでも無効化できる", async () => {
    const long = "あ".repeat(300);
    const tagIds = Array.from({ length: 150 }, (_, i) => i + 1);
    const input = validInput({
      status: "inactive",
      cond: { ...validInput().cond, partnerKey: long, descriptionKeyword: long },
      action: { ...validInput().action, descriptionTemplate: long, tagIds },
      validFrom: "0001-01-01",
      validTo: "9999-12-31",
    });
    const { client, calls } = fakeClient(ruleScenario());
    expect(await submitRuleVersion(client, input)).toMatchObject({ ok: true, version: 4, status: "inactive" });
    const row = arg(inserts(calls)[0]!, "insert") as Record<string, unknown>;
    expect(row).toMatchObject({ description_template: long, cond_partner_key: long, tag_ids: tagIds, valid_from: "0001-01-01", valid_to: "9999-12-31" });
  });

  it("編集元の版が古ければ保存しない（同時編集を上書きしない）", async () => {
    const { client, calls } = fakeClient(ruleScenario({ versions: [versionRow({ version: 5 })] }));
    const result = await submitRuleVersion(client, validInput({ expectedVersion: 3 }));
    expect(result).toMatchObject({ ok: false, outcome: "not_saved", code: "stale" });
    expect(result.message).toContain("版3");
    expect(result.message).toContain("版5");
    expect(writes(calls)).toHaveLength(0);
    // 現在の版より新しい版を名乗る入力も保存しない
    const ahead = fakeClient(ruleScenario());
    expect(await submitRuleVersion(ahead.client, validInput({ expectedVersion: 4 }))).toMatchObject({ ok: false, code: "stale" });
    expect(writes(ahead.calls)).toHaveLength(0);
  });

  it("同じ版の同時保存は主キー競合(23505)として返し、自動では再試行しない", async () => {
    const { client, calls } = fakeClient(ruleScenario({ insert: () => fail('duplicate key value violates unique constraint "journal_rule_versions_pkey"', "23505") }));
    const result = await submitRuleVersion(client, validInput());
    expect(result).toMatchObject({ ok: false, outcome: "not_saved", code: "conflict" });
    expect(JSON.stringify(result)).not.toContain("pkey");
    expect(inserts(calls)).toHaveLength(1);
  });

  it("権限・制約による拒否は保存していないと返し、内部のメッセージを出さない", async () => {
    const cases: [string, string][] = [
      ["42501", "denied"],
      ["23514", "rejected"],
      ["23503", "rejected"],
      ["P0001", "rejected"],
    ];
    for (const [code, expected] of cases) {
      const { client, calls } = fakeClient(ruleScenario({ insert: () => fail(SECRET, code) }));
      const result = await submitRuleVersion(client, validInput());
      expect(result, code).toMatchObject({ ok: false, outcome: "not_saved", code: expected });
      expect(JSON.stringify(result)).not.toContain("sk-secret");
      expect(inserts(calls)).toHaveLength(1);
    }
  });

  it("通信失敗・応答の欠落・コードのないエラーは結果不明とし、保存していないとは言わず、再送もしない", async () => {
    const variants: Array<(c: Call) => ReturnType<ReturnType<typeof ruleScenario>>> = [
      () => {
        throw new Error(SECRET);
      },
      () => Promise.reject(new Error(SECRET)),
      () => fail("TypeError: fetch failed " + SECRET, ""),
      () => fail(SECRET),
      () => fail(SECRET, "PGRST116"),
      () => fail(SECRET, "57014"),
      () => ok(null),
      () => ok(versionRow({ version: 9, status: "active", source: "staff" })), // 戻り値が書いた行と違う
      () => ok(versionRow({ version: 4, status: "active", source: "past_entries", created_by: USER })),
      () => ok(versionRow({ version: 4, status: "active", source: "staff", created_by: OTHER_CID })),
      () => ok(versionRow({ version: 4, status: "active", source: "staff", customer_id: OTHER_CID })),
      () => ok("not a row"),
    ];
    for (const [i, insert] of variants.entries()) {
      const { client, calls } = fakeClient(ruleScenario({ insert }));
      const result = await submitRuleVersion(client, validInput());
      expect(result, `variant ${i}`).toEqual({ ok: false, outcome: "unknown", code: "unknown", message: UNKNOWN_OUTCOME_MESSAGE });
      expect(result.message).not.toContain("sk-secret");
      expect(result.message).toContain("保存されていない、とは言い切れません");
      expect(inserts(calls)).toHaveLength(1);
    }
  });

  it("保存前の読込の失敗は、内部のメッセージを出さず、保存していないと返す", async () => {
    const tables = ["customers", "journal_rules", "journal_rule_versions", "wallets", "freee_masters"];
    for (const table of tables) {
      const base = ruleScenario({ wallets: walletRows() });
      const { client, calls } = fakeClient((c) => (c.table === table && !has(c, "insert") ? fail(SECRET, "XX000") : base(c)), {});
      const input = validInput({ cond: { ...validInput().cond, walletId: WID } });
      const result = await submitRuleVersion(client, input);
      expect(result, table).toMatchObject({ ok: false, outcome: "not_saved", code: "unavailable" });
      expect(JSON.stringify(result)).not.toContain("sk-secret");
      expect(writes(calls)).toHaveLength(0);
    }
  });

  it("空白だけの条件は null で保存し、取引先キーは入力のまま保存する", async () => {
    const { client, calls } = fakeClient(ruleScenario());
    const input = validInput({
      status: "inactive",
      cond: { partnerKey: " ACME ", descriptionKeyword: " 　", amountMin: null, amountMax: null, walletId: null, direction: null },
      action: { ...validInput().action, descriptionTemplate: "\n" },
    });
    expect(await submitRuleVersion(client, input)).toMatchObject({ ok: true });
    expect(arg(inserts(calls)[0]!, "insert")).toMatchObject({ cond_partner_key: " ACME ", cond_description_keyword: null, description_template: null });
  });

  it("以前の版を残す: 既存の版の読取だけで、同じ版番号を書き込まない", async () => {
    const { client, calls } = fakeClient(ruleScenario({ versions: [versionRow({ version: 7 })] }));
    const result = await submitRuleVersion(client, validInput({ expectedVersion: 7 }));
    expect(result).toMatchObject({ ok: true, version: 8 });
    const row = arg(inserts(calls)[0]!, "insert") as { version: number };
    expect(row.version).toBe(8);
    expect(calls.filter((c) => c.table === "journal_rule_versions" && !has(c, "insert")).every((c) => !has(c, "update") && !has(c, "delete"))).toBe(true);
  });

  it("入力に含めた顧客・ルール以外の行には書かない（ID が他の顧客でも自分の権限の範囲で拒否される）", async () => {
    const { client, calls } = fakeClient(ruleScenario({ customer: null }));
    const result = await submitRuleVersion(client, validInput({ customerId: OTHER_CID }));
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(writes(calls)).toHaveLength(0);
  });
});
