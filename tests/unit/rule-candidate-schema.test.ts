import { describe, expect, it } from "vitest";
import {
  createRuleFromCandidateSchema,
  draftToCreateInput,
  newRuleHref,
  parseCandidateQuery,
} from "@/lib/rules/candidate-schema";
import { CID } from "../fixtures/rule-editor";
import { REQUEST_ID, validCreateInput } from "../fixtures/rule-candidate";

const query = (o: Record<string, unknown> = {}) => ({ key: "ACME", direction: "expense", accountId: "100", requestId: REQUEST_ID, ...o });
const base = { customerId: CID, requestId: REQUEST_ID, partnerKey: "ACME", direction: "expense" as const, accountItemId: 100 };

describe("候補の URL 検索パラメータ", () => {
  it("正しい値は数値化して受け付ける（前後の空白を含むキーも入力のまま）", () => {
    expect(parseCandidateQuery(query())).toEqual({ key: "ACME", direction: "expense", accountId: 100, requestId: REQUEST_ID });
    expect(parseCandidateQuery(query({ key: " ACME " }))?.key).toBe(" ACME ");
  });

  it("欠落・空白だけのキー・配列・未知のキー・不正な科目ID・不正な依頼IDは拒否する", () => {
    const bad = [
      query({ key: undefined }),
      query({ key: "  　" }),
      query({ key: ["a", "b"] }),
      query({ direction: "both" }),
      query({ accountId: "0" }),
      query({ accountId: "-1" }),
      query({ accountId: "1.5" }),
      query({ accountId: "012" }),
      query({ accountId: "9007199254740993" }),
      query({ accountId: "" }),
      query({ requestId: "not-a-uuid" }),
      query({ status: "active" }),
      null,
      "x",
    ];
    for (const q of bad) expect(parseCandidateQuery(q), JSON.stringify(q)).toBeNull();
  });
});

describe("リンクの作り方", () => {
  it("キー・向き・科目ID・依頼IDを URLSearchParams でエンコードし、往復しても同じ値になる", () => {
    const key = "A&B=C ?#/日本 語%";
    const href = newRuleHref(CID, { partnerKey: key, direction: "income", accountItemId: 7 }, REQUEST_ID);
    expect(href.startsWith(`/customers/${CID}/rules/new?`)).toBe(true);
    expect(href).not.toContain("A&B");
    const params = Object.fromEntries(new URL(href, "http://x").searchParams);
    expect(params).toEqual({ key, direction: "income", accountId: "7", requestId: REQUEST_ID });
    expect(parseCandidateQuery(params)).toMatchObject({ key, accountId: 7 });
  });
});

describe("保存の入力", () => {
  it("正しい入力を受け付け、税区分 0 も優先順位 0 も本物の値として通す", () => {
    expect(createRuleFromCandidateSchema.safeParse(validCreateInput()).success).toBe(true);
    expect(createRuleFromCandidateSchema.safeParse(validCreateInput({ taxCode: 0, priority: 0 })).success).toBe(true);
  });

  it("作成者・状態・作成元・版・有効フラグ・その他の項目は strict で拒否する", () => {
    for (const extra of [
      { status: "active" },
      { active: true },
      { createdBy: CID },
      { created_by: CID },
      { source: "staff" },
      { version: 2 },
      { ruleId: REQUEST_ID },
      { cond: {} },
      { amountMin: 1 },
      { validFrom: "2026-01-01" },
    ]) {
      expect(createRuleFromCandidateSchema.safeParse(validCreateInput(extra)).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("不正な値を拒否する（空白キー・科目ID・int32 超過・null・文字列の数値）", () => {
    for (const o of [
      { partnerKey: "" },
      { partnerKey: " 　" },
      { direction: "x" },
      { accountItemId: 0 },
      { accountItemId: 1.5 },
      { accountItemId: Number.MAX_SAFE_INTEGER + 1 },
      { taxCode: null },
      { taxCode: "10" },
      { taxCode: 2_147_483_648 },
      { priority: null },
      { priority: 1.5 },
      { priority: -2_147_483_649 },
      { customerId: "x" },
      { requestId: "x" },
    ]) {
      expect(createRuleFromCandidateSchema.safeParse(validCreateInput(o)).success, JSON.stringify(o)).toBe(false);
    }
  });
});

describe("画面の入力欄から保存の入力へ", () => {
  it("税区分・優先順位が空欄なら作らない（0 にしない）", () => {
    expect(draftToCreateInput(base, { taxCode: "", priority: "100" })).toMatchObject({ ok: false });
    expect(draftToCreateInput(base, { taxCode: "10", priority: "" })).toMatchObject({ ok: false });
    expect(draftToCreateInput(base, { taxCode: "  ", priority: "  " })).toMatchObject({ ok: false });
  });

  it("書式が違えば作らない", () => {
    expect(draftToCreateInput(base, { taxCode: "1e1", priority: "100" })).toMatchObject({ ok: false });
    expect(draftToCreateInput(base, { taxCode: "10", priority: "1.5" })).toMatchObject({ ok: false });
    expect(draftToCreateInput(base, { taxCode: "10", priority: "abc" })).toMatchObject({ ok: false });
  });

  it("選んだ税区分 0 は 0 として渡す（空欄とは区別する）", () => {
    const r = draftToCreateInput(base, { taxCode: "0", priority: "0" });
    expect(r).toEqual({ ok: true, input: { ...base, taxCode: 0, priority: 0 } });
  });
});
