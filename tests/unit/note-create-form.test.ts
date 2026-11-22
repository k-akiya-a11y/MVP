import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// useState を差し替え、保存中（busy）などの状態を指定して描画する（ブラウザ・DOM ライブラリは使わない。入力・クリックの操作は未確認）
// フォームの useState の並び: title, body, confirmed, busy, locked, notice
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
vi.mock("@/app/customers/[customerId]/notes/new/actions", () => ({ createCustomerNoteAction: vi.fn() }));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown }) => createElement("a", { href: p.href }, p.children as never),
}));

import { NewNoteForm } from "@/app/customers/[customerId]/notes/new/new-note-form";
import { CID, NID } from "../fixtures/note-editor";

type Forced = { title?: string; body?: string; confirmed?: boolean; busy?: boolean; locked?: boolean };
const render = (s: Forced = {}) => {
  forced.calls = 0;
  forced.values = [];
  const order = ["title", "body", "confirmed", "busy", "locked"] as const;
  order.forEach((k, i) => {
    if (k in s) forced.values[i] = s[k];
  });
  return renderToStaticMarkup(createElement(NewNoteForm, { customerId: CID, requestId: NID }));
};

const tag = (html: string, name: "input" | "textarea" | "button", match: RegExp) => {
  const tags = html.match(new RegExp(`<${name}[^>]*>`, "g")) ?? [];
  const found = tags.filter((t) => match.test(t));
  expect(found).toHaveLength(1);
  const matched = found[0];
  if (matched === undefined) throw new Error(`<${name}> タグが見つかりません（条件: ${match}）`);
  return matched;
};
const isDisabled = (t: string) => /\sdisabled=""/.test(t);

beforeEach(() => {
  forced.calls = 0;
  forced.values = [];
});

describe("新規メモフォームの入力欄の無効化", () => {
  it("保存中（busy）は、タイトル・本文・確認チェック・保存ボタンがすべて無効になる（保存済みの表示ではない）", () => {
    const html = render({ title: "件名", body: "本文", confirmed: true, busy: true, locked: false });
    expect(isDisabled(tag(html, "input", /type="text"/))).toBe(true);
    expect(isDisabled(tag(html, "textarea", /rows="8"/))).toBe(true);
    expect(isDisabled(tag(html, "input", /type="checkbox"/))).toBe(true);
    expect(isDisabled(tag(html, "button", /./))).toBe(true);
    expect(html).not.toContain("この画面からは再送できません");
  });

  it("保存済み・結果不明・競合のあと（locked）も、すべて無効のまま", () => {
    const html = render({ title: "件名", body: "本文", confirmed: false, busy: false, locked: true });
    expect(isDisabled(tag(html, "input", /type="text"/))).toBe(true);
    expect(isDisabled(tag(html, "textarea", /rows="8"/))).toBe(true);
    expect(isDisabled(tag(html, "input", /type="checkbox"/))).toBe(true);
    expect(isDisabled(tag(html, "button", /./))).toBe(true);
    expect(html).toContain("この画面からは再送できません");
  });

  it("busy でも locked でもないときは、入力欄とチェックは有効で、確認済みなら保存ボタンも有効（確認前は無効）", () => {
    const idle = render({ title: "件名", body: "本文", confirmed: false });
    expect(isDisabled(tag(idle, "input", /type="text"/))).toBe(false);
    expect(isDisabled(tag(idle, "textarea", /rows="8"/))).toBe(false);
    expect(isDisabled(tag(idle, "input", /type="checkbox"/))).toBe(false);
    expect(isDisabled(tag(idle, "button", /./))).toBe(true);

    const ready = render({ title: "件名", body: "本文", confirmed: true });
    expect(isDisabled(tag(ready, "input", /type="text"/))).toBe(false);
    expect(isDisabled(tag(ready, "textarea", /rows="8"/))).toBe(false);
    expect(isDisabled(tag(ready, "button", /./))).toBe(false);
  });
});
