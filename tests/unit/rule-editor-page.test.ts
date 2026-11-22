import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// モジュール単位の合成テスト（ブラウザ・実 DB は通らない。クリックなどの操作は未確認）
const loadRuleEditor = vi.fn();
const createUserClient = vi.fn();
const saveRuleVersionAction = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createUserClient: () => createUserClient() }));
vi.mock("@/lib/rules/editor-load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rules/editor-load")>()),
  loadRuleEditor: (...a: unknown[]) => loadRuleEditor(...a),
}));
vi.mock("@/app/customers/[customerId]/rules/actions", () => ({ saveRuleVersionAction: (...a: unknown[]) => saveRuleVersionAction(...a) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));

import RulesPage from "@/app/customers/[customerId]/rules/page";
import { RULE_LOAD_FAILED_MESSAGE, toEditorRule, ruleVersionRowSchema, type RuleEditorData } from "@/lib/rules/editor-load";
import { CID, RID, SECRET, versionRow } from "../fixtures/rule-editor";

const render = async () => renderToStaticMarkup(await RulesPage({ params: Promise.resolve({ customerId: CID }) }));

const data = (rules = [toEditorRule(ruleVersionRowSchema.parse(versionRow()))]): RuleEditorData => ({
  customer: { id: CID, name: "テスト商事" },
  rules,
  masters: {
    account_item: [{ id: 100, name: "消耗品費" }],
    tax: [{ id: 10, name: "課税仕入10%" }],
    partner: [],
    item: [],
    section: [],
    tag: [],
  },
  wallets: [],
});

beforeEach(() => {
  loadRuleEditor.mockReset();
  createUserClient.mockReset();
  saveRuleVersionAction.mockReset();
  createUserClient.mockResolvedValue({});
});

describe("顧客ルールの確認・編集画面", () => {
  it("読込の例外の中身は表示せず、固定の失敗文だけを出す（ルールなしとも区別する）", async () => {
    loadRuleEditor.mockRejectedValue(new Error(SECRET));
    const html = await render();
    expect(html).toContain(RULE_LOAD_FAILED_MESSAGE);
    expect(html).not.toContain("sk-secret");
    expect(html).not.toContain("保存されているルールはありません");
  });

  it("クライアント作成の失敗も同じ固定文", async () => {
    createUserClient.mockRejectedValue(new Error(SECRET));
    const html = await render();
    expect(html).toContain(RULE_LOAD_FAILED_MESSAGE);
    expect(html).not.toContain("sk-secret");
  });

  it("顧客が見えない（null）ときは notFound", async () => {
    loadRuleEditor.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("ルールの状態・版・条件・処理を一覧し、読み込んだだけでは保存の操作を出さない", async () => {
    loadRuleEditor.mockResolvedValue(data());
    const html = await render();
    expect(html).toContain("テスト商事：顧客ルール");
    expect(html).toContain("提案中");
    expect(html).toContain("取引先キー「ACME」");
    expect(html).toContain("1000円以上");
    expect(html).toContain("50000円未満");
    expect(html).toContain("出金");
    expect(html).toContain("消耗品費（ID 100）");
    expect(html).toContain("課税仕入10%（ID 10）");
    // 選択前は編集フォームも保存ボタンもない（表示・選択で保存や有効化をしない）
    expect(html).not.toContain("<form");
    expect(html).not.toContain("として新しい版を保存");
    expect(html).toContain("編集する");
    expect(saveRuleVersionAction).not.toHaveBeenCalled();
  });

  it("一覧にルールIDを表示する（新規作成の結果不明のとき、IDで既存の一覧から探せる）", async () => {
    loadRuleEditor.mockResolvedValue(data());
    const html = await render();
    expect(html).toContain("<th>ルールID</th>");
    expect(html).toContain(`<code>${RID}</code>`);
  });

  it("有効化の影響・Phase 1 の人の確認・旧版の保持・作成対象外を説明する", async () => {
    loadRuleEditor.mockResolvedValue(data());
    const html = await render();
    expect(html).toContain("以降に作る仕訳候補の照合に使われ");
    expect(html).toContain("すでに作成済みの仕訳候補は変わりません");
    expect(html).toContain("Phase 1 では必ず人（承認者）が確認して承認します");
    expect(html).toContain("以前の版は消えず");
    expect(html).toContain("新しいルールの作成と、過去仕訳の候補からの自動変換はできません。文章メモは、上の「文章メモを確認・編集する」から専用のページで確認・編集できます");
  });

  it("ルールが0件のときは、失敗とは別の文言", async () => {
    loadRuleEditor.mockResolvedValue(data([]));
    const html = await render();
    expect(html).toContain("保存されているルールはありません");
    expect(html).not.toContain(RULE_LOAD_FAILED_MESSAGE);
  });

  it("承認画面と過去仕訳の確認画面へ戻れる", async () => {
    loadRuleEditor.mockResolvedValue(data());
    const html = await render();
    expect(html).toContain(`href="/customers/${CID}"`);
    expect(html).toContain(`href="/customers/${CID}/past-quality"`);
  });
});
