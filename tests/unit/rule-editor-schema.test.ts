import { describe, expect, it } from "vitest";
import { draftToInput, toDraft } from "@/lib/rules/editor-draft";
import type { EditorRule } from "@/lib/rules/editor-load";
import { formatEditorIssues, isRealIsoDate, ruleEditorSubmitSchema } from "@/lib/rules/editor-schema";
import { CID, RID, WID, validInput } from "../fixtures/rule-editor";

const parse = (o: Record<string, unknown> = {}) => ruleEditorSubmitSchema.safeParse(validInput(o));
const withCond = (c: Record<string, unknown>) => parse({ cond: { ...validInput().cond, ...c } });
const withAction = (a: Record<string, unknown>) => parse({ action: { ...validInput().action, ...a } });

describe("ルール編集の入力検証（純粋関数）", () => {
  it("正しい入力を受け付ける", () => {
    expect(parse().success).toBe(true);
  });

  it("実在する日付だけを受け付ける（うるう年を含む）", () => {
    for (const ok of ["2024-02-29", "2000-02-29", "2026-12-31", "0001-01-01", "1899-12-31", "2101-01-01", "9999-12-31"]) expect(isRealIsoDate(ok), ok).toBe(true);
    for (const bad of ["2023-02-29", "1900-02-29", "2100-02-29", "2024-02-30", "2024-13-01", "2024-00-10", "2024-04-31", "2024-2-1", "2024/02/01", "24-02-01", "0000-01-01", "10000-01-01", "", " 2024-02-01"]) {
      expect(isRealIsoDate(bad), bad).toBe(false);
    }
    expect(parse({ validFrom: "2023-02-29" }).success).toBe(false);
    expect(parse({ validTo: "2024-02-29" }).success).toBe(true);
  });

  it("DB にない独自の上限（文字数・タグ数）は設けない", () => {
    expect(withAction({ descriptionTemplate: "あ".repeat(251) }).success).toBe(true);
    expect(withCond({ partnerKey: "a".repeat(1000) }).success).toBe(true);
    expect(withAction({ tagIds: Array.from({ length: 101 }, (_, i) => i + 1) }).success).toBe(true);
    expect(parse({ validTo: "9999-12-31" }).success).toBe(true);
  });

  it("有効期間は開始日が終了日以前（同日は可）", () => {
    expect(parse({ validFrom: "2026-04-01", validTo: "2026-03-31" }).success).toBe(false);
    expect(parse({ validFrom: "2026-04-01", validTo: "2026-04-01" }).success).toBe(true);
    expect(parse({ validFrom: "2026-04-01", validTo: null }).success).toBe(true);
    expect(parse({ validFrom: null, validTo: "2026-04-01" }).success).toBe(true);
  });

  it("空白だけの条件は null になり、条件が1つもなければ拒否する", () => {
    const onlyBlank = withCond({ partnerKey: " 　\n", descriptionKeyword: "  ", amountMin: null, amountMax: null, walletId: null, direction: null });
    expect(onlyBlank.success).toBe(false);
    const keyword = withCond({ partnerKey: "  ", descriptionKeyword: "ｱﾏｿﾞﾝ", amountMin: null, amountMax: null, direction: null });
    expect(keyword.success).toBe(true);
    if (keyword.success) expect(keyword.data.cond.partnerKey).toBeNull();
    // 金額・口座・向きだけでも条件になる
    expect(withCond({ partnerKey: null, amountMin: 0, amountMax: null, direction: null }).success).toBe(true);
    expect(withCond({ partnerKey: null, amountMin: null, amountMax: null, walletId: WID, direction: null }).success).toBe(true);
    expect(withCond({ partnerKey: null, amountMin: null, amountMax: null, direction: "income" }).success).toBe(true);
  });

  it("空白以外を含む取引先キーは前後の空白も含めて入力のまま保つ", () => {
    const r = withCond({ partnerKey: "  ACME  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.cond.partnerKey).toBe("  ACME  ");
    const t = withAction({ descriptionTemplate: " {month}月分 " });
    if (t.success) expect(t.data.action.descriptionTemplate).toBe(" {month}月分 ");
    const blank = withAction({ descriptionTemplate: "   " });
    if (blank.success) expect(blank.data.action.descriptionTemplate).toBeNull();
  });

  it("金額は DB と同じ範囲（下限は0以上・以上、上限は1以上・未満、下限<上限）", () => {
    expect(withCond({ amountMin: 0, amountMax: 1 }).success).toBe(true);
    expect(withCond({ amountMin: -1 }).success).toBe(false);
    expect(withCond({ amountMax: 0 }).success).toBe(false);
    expect(withCond({ amountMin: 100, amountMax: 100 }).success).toBe(false);
    expect(withCond({ amountMin: 101, amountMax: 100 }).success).toBe(false);
    expect(withCond({ amountMin: 1.5 }).success).toBe(false);
    expect(withCond({ amountMax: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(withCond({ amountMin: Number.MAX_SAFE_INTEGER, amountMax: null }).success).toBe(true);
    expect(withCond({ amountMin: "100" }).success).toBe(false);
    expect(withCond({ amountMin: Number.NaN }).success).toBe(false);
  });

  it("ID は安全な正の整数、優先順位・税区分・版は int32", () => {
    expect(withAction({ accountItemId: 0 }).success).toBe(false);
    expect(withAction({ accountItemId: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(withAction({ accountItemId: 1.2 }).success).toBe(false);
    expect(withAction({ accountItemId: null }).success).toBe(false);
    expect(withAction({ partnerId: 9007199254740991 }).success).toBe(true);
    expect(withAction({ tagIds: [1, 1] }).success).toBe(false);
    expect(withAction({ tagIds: [1, 2.5] }).success).toBe(false);
    expect(withAction({ tagIds: [5, 6] }).success).toBe(true);
    expect(withAction({ taxCode: 2_147_483_647 }).success).toBe(true);
    expect(withAction({ taxCode: 2_147_483_648 }).success).toBe(false);
    expect(parse({ priority: -2_147_483_648 }).success).toBe(true);
    expect(parse({ priority: 2_147_483_648 }).success).toBe(false);
    expect(parse({ priority: 1.5 }).success).toBe(false);
    expect(parse({ priority: "100" }).success).toBe(false);
    expect(parse({ expectedVersion: 0 }).success).toBe(false);
    expect(parse({ expectedVersion: 2_147_483_646 }).success).toBe(true);
    expect(parse({ expectedVersion: 2_147_483_647 }).success).toBe(false); // 次の版が int32 を超える
  });

  it("状態・向き・口座・顧客・ルールの形式を検証する", () => {
    expect(parse({ status: "deleted" }).success).toBe(false);
    expect(parse({ status: undefined }).success).toBe(false);
    expect(withCond({ direction: "both" }).success).toBe(false);
    expect(withCond({ walletId: "not-a-uuid" }).success).toBe(false);
    expect(parse({ customerId: "x" }).success).toBe(false);
    expect(parse({ ruleId: "x" }).success).toBe(false);
    expect(ruleEditorSubmitSchema.safeParse(null).success).toBe(false);
    expect(ruleEditorSubmitSchema.safeParse("x").success).toBe(false);
  });

  it("作成者・作成元・版番号・顧客など、入力にない項目は（入れ子も）拒否する", () => {
    for (const extra of [{ createdBy: CID }, { created_by: CID }, { source: "staff" }, { version: 9 }, { customer_id: CID }, { rule_id: RID }]) {
      expect(parse(extra).success, JSON.stringify(extra)).toBe(false);
    }
    expect(withCond({ createdBy: CID }).success).toBe(false);
    expect(withCond({ customerId: CID }).success).toBe(false);
    expect(withAction({ source: "staff" }).success).toBe(false);
  });

  it("エラー文に入力値や内部の経路を含めない", () => {
    const r = parse({ customerId: "sk-secret-token", extra: 1 });
    expect(r.success).toBe(false);
    if (!r.success) {
      const text = formatEditorIssues(r.error);
      expect(text).not.toContain("sk-secret");
      expect(text).not.toContain("extra");
    }
  });
});

describe("編集中の値と入力の変換", () => {
  const rule: EditorRule = {
    ruleId: RID,
    version: 3,
    status: "proposed",
    source: "past_entries",
    priority: 50,
    cond: { partnerKey: " ACME ", descriptionKeyword: null, amountMin: 0, amountMax: 99999, walletId: WID, direction: null },
    action: { accountItemId: 100, taxCode: 10, partnerId: 7, itemId: null, sectionId: null, tagIds: [5, 6], descriptionTemplate: "{month}月分" },
    validFrom: "2026-01-01",
    validTo: null,
    createdAt: "2026-10-01T00:00:00+00:00",
  };

  it("保存されている現在の版から始め、既定値を足さずに同じ内容の入力に戻る", () => {
    const input = draftToInput({ customerId: CID, ruleId: RID, expectedVersion: 3, status: "inactive", draft: toDraft(rule) });
    const parsed = ruleEditorSubmitSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.cond).toEqual(rule.cond); // 取引先キーの空白も、下限0も、そのまま
    expect(parsed.data.action).toEqual(rule.action);
    expect(parsed.data.priority).toBe(50);
    expect(parsed.data.validFrom).toBe("2026-01-01");
    expect(parsed.data.validTo).toBeNull();
    expect(Object.keys(input as object).sort()).toEqual(["action", "cond", "customerId", "expectedVersion", "priority", "ruleId", "status", "validFrom", "validTo"]);
  });

  it("数字でない入力は NaN や0にせず、検証で拒否される", () => {
    const draft = { ...toDraft(rule), amountMax: "12abc", priority: "" };
    const parsed = ruleEditorSubmitSchema.safeParse(draftToInput({ customerId: CID, ruleId: RID, expectedVersion: 3, status: "active", draft }));
    expect(parsed.success).toBe(false);
  });
});
