import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// useState を差し替え、保存中（busy）などの状態を指定して描画する（ブラウザ・DOM ライブラリは使わない。入力・クリックの操作は未確認）
// 描画順の useState: RuleEditor = selectedId, notice, reloads / RuleForm = draft, confirmed, busy, locked
const forced = vi.hoisted(() => ({ values: [] as unknown[], calls: 0 }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = forced.calls++ % 7;
      if (i in forced.values) return [forced.values[i], () => {}];
      return [typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}];
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/customers/[customerId]/rules/actions", () => ({ saveRuleVersionAction: vi.fn() }));

import { RuleEditor } from "@/app/customers/[customerId]/rules/rule-editor";
import type { EditorRule } from "@/lib/rules/editor-load";
import { CID, RID } from "../fixtures/rule-editor";

const rule: EditorRule = {
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
};
const masters = {
  account_item: [{ id: 100, name: "消耗品費" }],
  tax: [{ id: 10, name: "課税仕入10%" }],
  partner: [{ id: 7, name: "架空商事" }],
  item: [],
  section: [],
  tag: [{ id: 5, name: "タグA" }],
};
const wallets = [{ id: "33333333-3333-4333-8333-333333333333", name: "普通預金", kind: "bank_account" }];

type Forced = { confirmed?: boolean; busy?: boolean; locked?: boolean };
const render = (s: Forced = {}) => {
  forced.calls = 0;
  forced.values = [];
  forced.values[0] = RID; // 編集するルールを選んだ状態
  if ("confirmed" in s) forced.values[4] = s.confirmed;
  if ("busy" in s) forced.values[5] = s.busy;
  if ("locked" in s) forced.values[6] = s.locked;
  return renderToStaticMarkup(createElement(RuleEditor, { customerId: CID, rules: [rule], masters, wallets }));
};

/** 編集フォームの条件・処理・優先順位の入力欄を囲む fieldset と、その外にある入力欄（確認チェック）に分ける */
const split = (html: string) => {
  const form = html.slice(html.indexOf("<form"));
  const start = form.indexOf("<fieldset");
  const end = form.lastIndexOf("</fieldset>") + "</fieldset>".length;
  const controls = (s: string) => s.match(/<(?:input|select|textarea)[^>]*>/g) ?? [];
  return {
    fieldsets: form.match(/<fieldset[^>]*>/g) ?? [],
    inside: controls(form.slice(start, end)),
    outside: controls(form.slice(0, start) + form.slice(end)),
    buttons: form.match(/<button[^>]*>/g) ?? [],
  };
};
const isDisabled = (t: string) => /\sdisabled=""/.test(t);

beforeEach(() => {
  forced.calls = 0;
  forced.values = [];
});

describe("ルール編集フォームの入力欄の無効化", () => {
  it("描画の前提: 入力欄（テキスト・選択・日付・メモタグ）が複数あり、条件・処理・優先順位の3つの fieldset に収まっている", () => {
    const { fieldsets, inside, outside } = split(render());
    // 外側3つ + メモタグの入れ子1つ
    expect(fieldsets).toHaveLength(4);
    expect(inside.length).toBeGreaterThanOrEqual(12);
    expect(inside.some((t) => /type="date"/.test(t))).toBe(true);
    expect(inside.some((t) => /type="checkbox"/.test(t))).toBe(true);
    expect(inside.some((t) => /^<select/.test(t))).toBe(true);
    expect(outside).toHaveLength(1);
  });

  it("保存中（busy）は、入力欄を囲む fieldset がすべて無効で、確認チェックと保存ボタンも無効", () => {
    const { fieldsets, outside, buttons } = split(render({ confirmed: true, busy: true, locked: false }));
    expect(fieldsets.filter(isDisabled)).toHaveLength(3);
    expect(outside.every(isDisabled)).toBe(true);
    const saves = buttons.filter((b) => !/aria-pressed/.test(b));
    expect(saves).toHaveLength(3);
    expect(saves.every(isDisabled)).toBe(true);
  });

  it("保存済み・結果不明・競合のあと（locked）も、fieldset・確認チェック・保存ボタンは無効のまま", () => {
    const html = render({ confirmed: false, busy: false, locked: true });
    const { fieldsets, outside, buttons } = split(html);
    expect(fieldsets.filter(isDisabled)).toHaveLength(3);
    expect(outside.every(isDisabled)).toBe(true);
    expect(buttons.filter((b) => !/aria-pressed/.test(b)).every(isDisabled)).toBe(true);
    expect(html).toContain("最新の状態を読み込む");
  });

  it("busy でも locked でもないときは、fieldset も確認チェックも有効で、確認済みなら保存ボタンも有効（確認前は無効）", () => {
    const idle = split(render({ confirmed: false }));
    expect(idle.fieldsets.some(isDisabled)).toBe(false);
    expect(idle.outside.some(isDisabled)).toBe(false);
    expect(idle.buttons.filter((b) => !/aria-pressed/.test(b)).every(isDisabled)).toBe(true);

    const ready = split(render({ confirmed: true }));
    expect(ready.fieldsets.some(isDisabled)).toBe(false);
    expect(ready.buttons.filter((b) => !/aria-pressed/.test(b)).some(isDisabled)).toBe(false);
  });
});
