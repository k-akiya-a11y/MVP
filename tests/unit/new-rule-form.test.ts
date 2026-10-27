import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// useState を差し替え、保存中（busy）などの状態を指定して描画する（ブラウザ・DOM ライブラリは使わない。入力・クリックの操作は未確認）
// フォームの useState の並び: taxCode, priority, confirmed, busy, locked, notice
const forced = vi.hoisted(() => ({ values: [] as unknown[], calls: 0 }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = forced.calls++ % 6;
      return [i in forced.values ? forced.values[i] : initial, () => {}];
    },
  };
});
vi.mock("@/app/customers/[customerId]/rules/new/actions", () => ({ createRuleFromCandidateAction: vi.fn() }));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));

import { NewRuleForm } from "@/app/customers/[customerId]/rules/new/new-rule-form";
import { CID } from "../fixtures/rule-editor";
import { REQUEST_ID } from "../fixtures/rule-candidate";

type Forced = { taxCode?: string; priority?: string; confirmed?: boolean; busy?: boolean; locked?: boolean };
const render = (s: Forced = {}) => {
  forced.calls = 0;
  forced.values = [];
  const order = ["taxCode", "priority", "confirmed", "busy", "locked"] as const;
  order.forEach((k, i) => {
    if (k in s) forced.values[i] = s[k];
  });
  return renderToStaticMarkup(
    createElement(NewRuleForm, {
      customerId: CID,
      requestId: REQUEST_ID,
      candidate: { partnerKey: "ACME", direction: "expense", accountItemId: 100, count: 2, dateRange: { from: "2026-01-05", to: "2026-02-05" } },
      accountName: "消耗品費",
      taxOptions: [
        { id: 10, name: "課税仕入10%" },
        { id: 0, name: "対象外" },
      ],
    }),
  );
};

/** 「人が決める項目」の fieldset（税区分・優先順位）と、その外の確認チェック・保存ボタンを取り出す */
const parts = (html: string) => {
  const start = html.lastIndexOf("<fieldset", html.indexOf("人が決める項目"));
  const end = html.indexOf("</fieldset>", start) + "</fieldset>".length;
  const editable = html.slice(start, end);
  const rest = html.slice(0, start) + html.slice(end);
  return {
    fieldset: editable.match(/<fieldset[^>]*>/)?.[0] ?? "",
    select: editable.match(/<select[^>]*>/g) ?? [],
    text: editable.match(/<input[^>]*>/g) ?? [],
    confirm: rest.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [],
    buttons: rest.match(/<button[^>]*>/g) ?? [],
  };
};
const isDisabled = (t: string) => /\sdisabled=""/.test(t);

beforeEach(() => {
  forced.calls = 0;
  forced.values = [];
});

describe("新規ルールフォームの入力欄の無効化", () => {
  it("描画の前提: 税区分の選択と優先順位の入力が1つずつ、確認チェックと保存ボタンが1つずつある", () => {
    const p = parts(render());
    expect(p.select).toHaveLength(1);
    expect(p.text).toHaveLength(1);
    expect(p.confirm).toHaveLength(1);
    expect(p.buttons).toHaveLength(1);
  });

  it("保存中（busy）は、税区分・優先順位を囲む fieldset と、確認チェック・保存ボタンがすべて無効になる", () => {
    const html = render({ taxCode: "10", priority: "100", confirmed: true, busy: true, locked: false });
    const p = parts(html);
    expect(isDisabled(p.fieldset)).toBe(true);
    expect([...p.confirm, ...p.buttons].every(isDisabled)).toBe(true);
    expect(html).not.toContain("この画面からは再送できません");
  });

  it("保存済み・結果不明・競合のあと（locked）も、すべて無効のまま", () => {
    const html = render({ taxCode: "10", priority: "100", confirmed: false, busy: false, locked: true });
    const p = parts(html);
    expect(isDisabled(p.fieldset)).toBe(true);
    expect([...p.confirm, ...p.buttons].every(isDisabled)).toBe(true);
    expect(html).toContain("この画面からは再送できません");
  });

  it("busy でも locked でもないときは、fieldset と確認チェックは有効で、確認済みなら保存ボタンも有効（確認前は無効）", () => {
    const idle = parts(render({ confirmed: false }));
    expect(isDisabled(idle.fieldset)).toBe(false);
    expect(idle.confirm.some(isDisabled)).toBe(false);
    expect(idle.buttons.every(isDisabled)).toBe(true);

    const ready = parts(render({ taxCode: "10", priority: "100", confirmed: true }));
    expect(isDisabled(ready.fieldset)).toBe(false);
    expect(ready.buttons.some(isDisabled)).toBe(false);
  });
});
