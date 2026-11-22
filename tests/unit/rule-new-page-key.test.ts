import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ページが返す要素の key だけを見る（描画しない）。同じ key なら React は入力・確認の状態を引き継ぐ
const loadCandidateSource = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createUserClient: async () => ({}) }));
vi.mock("@/lib/rules/candidate-load", async (orig) => ({
  ...(await orig<typeof import("@/lib/rules/candidate-load")>()),
  loadCandidateSource: (...a: unknown[]) => loadCandidateSource(...a),
}));
vi.mock("@/app/customers/[customerId]/rules/new/new-rule-form", () => ({ NewRuleForm: function NewRuleForm() { return null; } }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("next/link", () => ({ default: function Link() { return null; } }));

import NewRulePage from "@/app/customers/[customerId]/rules/new/page";
import { NewRuleForm } from "@/app/customers/[customerId]/rules/new/new-rule-form";
import { CID } from "../fixtures/rule-editor";
import { REQUEST_ID } from "../fixtures/rule-candidate";

const range = { from: "2026-01-05", to: "2026-02-05" };
type Over = { key?: string; direction?: string; accountId?: number; count?: number; accountName?: string; tax?: { id: number; name: string }[] };
const ready = (o: Over = {}) => ({
  kind: "ready",
  customer: { id: CID, name: "テスト商事" },
  candidate: {
    kind: "rule-consideration-candidate",
    direction: o.direction ?? "expense",
    partnerKey: o.key ?? "ACME",
    accountItemId: o.accountId ?? 100,
    count: o.count ?? 2,
    dateRange: range,
    entryIds: ["p1"],
  },
  account: { id: o.accountId ?? 100, name: o.accountName ?? "消耗品費" },
  taxOptions: o.tax ?? [{ id: 10, name: "課税仕入10%" }],
});

function findForm(node: ReactNode): { key: string | null } | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findForm(n);
      if (f) return f;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === NewRuleForm) return { key: node.key };
  return findForm((node.props as { children?: ReactNode }).children);
}

async function formKey(over: Over = {}, customerId = CID, requestId = REQUEST_ID, direction = "expense", accountId = "100", key = "ACME") {
  loadCandidateSource.mockResolvedValue(ready(over));
  const tree = await NewRulePage({
    params: Promise.resolve({ customerId }),
    searchParams: Promise.resolve({ key, direction, accountId, requestId }),
  });
  const form = findForm(tree);
  expect(form).not.toBeNull();
  return form!.key;
}

beforeEach(() => loadCandidateSource.mockReset());

describe("新規ルールのフォームの key（入力と確認の引き継ぎ）", () => {
  it("同じ候補・同じ依頼IDなら key は同じ", async () => {
    expect(await formKey()).toBe(await formKey());
  });

  it("同じ依頼IDでも、候補・顧客・根拠・科目・税区分の選択肢が変われば key が変わる", async () => {
    const base = await formKey();
    const changed = [
      await formKey({ key: "OTHER" }, CID, REQUEST_ID, "expense", "100", "OTHER"),
      await formKey({ direction: "income" }, CID, REQUEST_ID, "income"),
      await formKey({ accountId: 101 }, CID, REQUEST_ID, "expense", "101"),
      await formKey({ count: 3 }),
      await formKey({ accountName: "雑費" }),
      await formKey({ tax: [{ id: 10, name: "課税仕入10%" }, { id: 0, name: "対象外" }] }),
      await formKey({}, "00000000-0000-4000-8000-0000000000ff"),
    ];
    for (const k of changed) expect(k).not.toBe(base);
    expect(new Set([base, ...changed]).size).toBe(changed.length + 1);
  });

  it("依頼IDが変われば key が変わり、区切り文字を含む値でも別の組が同じ key にならない", async () => {
    const other = "70000000-0000-4000-8000-0000000000aa";
    expect(await formKey({}, CID, other)).not.toBe(await formKey());
    const a = await formKey({ key: 'a","b' }, CID, REQUEST_ID, "expense", "100", 'a","b');
    const b = await formKey({ key: "a" }, CID, REQUEST_ID, "expense", "100", "a");
    expect(a).not.toBe(b);
  });
});
