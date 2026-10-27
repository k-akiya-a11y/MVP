import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// モジュール単位の合成テスト（ブラウザ・実 DB は通らない）
const loadCandidateSource = vi.fn();
const createUserClient = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createUserClient: () => createUserClient() }));
vi.mock("@/lib/rules/candidate-load", async (orig) => ({
  ...(await orig<typeof import("@/lib/rules/candidate-load")>()),
  loadCandidateSource: (...a: unknown[]) => loadCandidateSource(...a),
}));
vi.mock("@/app/customers/[customerId]/rules/new/actions", () => ({ createRuleFromCandidateAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));

import NewRulePage from "@/app/customers/[customerId]/rules/new/page";
import { CID, SECRET } from "../fixtures/rule-editor";
import { REQUEST_ID } from "../fixtures/rule-candidate";

const sp = (o: Record<string, string | string[] | undefined> = {}) => ({ key: "ACME", direction: "expense", accountId: "100", requestId: REQUEST_ID, ...o });
const render = async (searchParams: Record<string, string | string[] | undefined> = sp()) =>
  renderToStaticMarkup(await NewRulePage({ params: Promise.resolve({ customerId: CID }), searchParams: Promise.resolve(searchParams) }));

const range = { from: "2026-01-05", to: "2026-02-05" };
const ready = (count = 2) => ({
  kind: "ready",
  customer: { id: CID, name: "テスト商事" },
  candidate: { kind: "rule-consideration-candidate", direction: "expense", partnerKey: "ACME", accountItemId: 100, count, dateRange: range, entryIds: ["p1"] },
  account: { id: 100, name: "消耗品費" },
  taxOptions: [
    { id: 0, name: "対象外" },
    { id: 10, name: "課税仕入10%" },
  ],
});

beforeEach(() => {
  loadCandidateSource.mockReset();
  createUserClient.mockReset();
  createUserClient.mockResolvedValue({});
});

describe("候補から新しいルールを作る画面", () => {
  it("候補は読取専用の事実として表示し、税区分・優先順位は空欄、保存ボタンは1つだけ", async () => {
    loadCandidateSource.mockResolvedValue(ready());
    const html = await render();
    expect(loadCandidateSource).toHaveBeenCalledWith({}, CID, { key: "ACME", direction: "expense", accountId: 100, requestId: REQUEST_ID });
    expect(html).toContain("ACME");
    expect(html).toContain("消耗品費（科目ID 100）");
    // 税区分は未選択（選んでください）で、既定の selected や 0 を入れない。優先順位は空
    expect(html).toMatch(/<option value=""[^>]*>選んでください<\/option>/);
    // selected が付くのは未選択の選択肢だけ（税区分 0 や他の値が最初から選ばれていない）
    expect([...html.matchAll(/<option([^>]*)>/g)].filter((m) => m[1]!.includes("selected")).every((m) => m[1]!.includes('value=""'))).toBe(true);
    expect(html).toMatch(/<option value="0">対象外（ID 0）<\/option>/);
    expect(html).toMatch(/<input type="text" inputMode="numeric" value=""/i);
    // 候補の値を入力欄にしない・有効化の入力を持たない
    expect(html).not.toMatch(/type="hidden"/);
    expect(html).not.toMatch(/name="(status|active|source|createdBy)"/);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("提案中として新しいルールを保存");
    expect(html).not.toMatch(/有効として|無効として/);
    // 確認用のチェックは未確認で、保存は押したときだけ
    expect(html).toMatch(/<button type="button" disabled=""/);
  });

  it("指定しない項目と意味、既存ルールの確認、提案中であることを保存前に示す", async () => {
    loadCandidateSource.mockResolvedValue(ready());
    const html = await render();
    for (const t of ["金額の条件", "口座", "摘要の語句", "有効期間", "補助科目", "摘要の雛形", "未指定"]) expect(html).toContain(t);
    expect(html).toContain("どんな金額の取引にも一致します");
    expect(html).toContain("すべての口座の取引に一致します");
    expect(html).toContain("既存のルール編集画面から新しい版として追加・変更できます");
    expect(html).toContain("重複は防がれません");
    expect(html).toContain(`href="/customers/${CID}/rules"`);
    expect(html).toContain("有効にはならず");
  });

  it("1件だけの根拠には警告を出す（複数件なら出さない）", async () => {
    loadCandidateSource.mockResolvedValue(ready(1));
    expect(await render()).toContain("根拠は1件の過去仕訳だけです");
    loadCandidateSource.mockResolvedValue(ready(2));
    expect(await render()).not.toContain("根拠は1件の過去仕訳だけです");
  });

  it("同じ URL を再描画しても依頼IDは同じ（ページが新しい依頼IDを作らない）", async () => {
    loadCandidateSource.mockResolvedValue(ready());
    const a = await render();
    const b = await render();
    expect(a).toBe(b);
    expect(loadCandidateSource.mock.calls.map((c) => (c[2] as { requestId?: string }).requestId)).toEqual([REQUEST_ID, REQUEST_ID]);
  });

  it("URL が不正なら読込に進まず、入力値も画面に出さない", async () => {
    for (const bad of [sp({ key: undefined }), sp({ key: ["a", "b"] }), sp({ accountId: "abc" }), sp({ requestId: "<script>x</script>" }), sp({ direction: "x" })]) {
      const html = await render(bad);
      expect(html).toContain("候補の指定が正しくない");
      expect(html).not.toContain("<script>x");
      expect(html).not.toMatch(/<button/);
    }
    expect(loadCandidateSource).not.toHaveBeenCalled();
    expect(createUserClient).not.toHaveBeenCalled();
  });

  it("候補が最新でない（stale・欠落・別の顧客の候補）ときは保存の操作を出さない", async () => {
    loadCandidateSource.mockResolvedValue({ kind: "blocked", customer: { id: CID, name: "テスト商事" }, reason: "candidate_missing" });
    const html = await render();
    expect(html).toContain("最新の過去仕訳にはありません");
    expect(html).not.toMatch(/<(button|form|select|input)\b/);
  });

  it("科目が有効でないときは理由を説明し、保存の操作を出さない", async () => {
    loadCandidateSource.mockResolvedValue({ kind: "blocked", customer: { id: CID, name: "テスト商事" }, reason: "account_unavailable" });
    const html = await render();
    expect(html).toContain("現在の有効なマスタにありません");
    expect(html).not.toMatch(/<(button|form|select|input)\b/);
  });

  it("顧客が見えない（null）ときは notFound。読込の例外は固定文だけを出す", async () => {
    loadCandidateSource.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    loadCandidateSource.mockRejectedValue(new Error(SECRET));
    const html = await render();
    expect(html).not.toContain("sk-secret");
    expect(html).toContain("読み込めなかったため");
    expect(html).not.toMatch(/<button/);
    createUserClient.mockRejectedValue(new Error(SECRET));
    expect(await render()).not.toContain("sk-secret");
  });
});
