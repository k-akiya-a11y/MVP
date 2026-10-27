import { arg, CID, fail, has, ok, page, USER, type Call, type Reply } from "./rule-editor";

export { arg, CID, eqs, fail, fakeClient, has, OTHER_CID, ok, page, SECRET, USER, type Call, type Reply } from "./rule-editor";

/** 文章メモ編集のテスト用の合成データ（架空のものだけ） */
export const NID = "55555555-5555-4555-8555-555555555555";

export const noteRow = (o: Record<string, unknown> = {}) => ({
  note_id: NID,
  version: 2,
  customer_id: CID,
  status: "active",
  title: "代表者カードの私用分",
  body: "私用分は役員貸付金で処理する。",
  created_by: USER,
  created_at: "2026-10-01T00:00:00+00:00",
  ...o,
});

type Scenario = {
  customer?: unknown;
  parent?: unknown;
  versions?: unknown[];
  insert?: (call: Call) => Reply | Promise<Reply>;
};

/** 保存処理が読む表（顧客・親メモ・版）と、版の INSERT への応答を返す標準の応答 */
export function noteScenario(s: Scenario = {}) {
  return (c: Call): Reply | Promise<Reply> => {
    switch (c.table) {
      case "customers":
        return ok(s.customer === undefined ? { id: CID, name: "テスト商事" } : s.customer);
      case "customer_notes":
        return ok(s.parent === undefined ? { id: NID, customer_id: CID } : s.parent);
      case "customer_note_versions":
        if (has(c, "insert")) {
          if (s.insert) return s.insert(c);
          const row = arg(c, "insert") as Record<string, unknown>;
          return ok({ ...noteRow(), ...row, created_at: "2026-10-24T00:00:00+00:00" });
        }
        return ok(s.versions ?? [noteRow()]);
      default:
        return fail(`unexpected table ${c.table}`);
    }
  };
}

/** 画面一覧の読込が読む表 */
export function noteLoaderScenario(t: { customer?: unknown; parents?: unknown[]; versions?: unknown[] } = {}) {
  return (c: Call): Reply => {
    switch (c.table) {
      case "customers":
        return ok(t.customer === undefined ? { id: CID, name: "テスト商事" } : t.customer);
      case "customer_notes":
        return page(t.parents ?? [{ id: NID, customer_id: CID }], c);
      case "current_customer_notes":
        return page(t.versions ?? [noteRow()], c);
      default:
        return fail(`unexpected table ${c.table}`);
    }
  };
}

/** 保存の入力（編集元は版2）。上書きしたい項目だけ渡す */
export const validNoteInput = (o: Record<string, unknown> = {}) => ({
  customerId: CID,
  noteId: NID,
  expectedVersion: 2,
  status: "active",
  title: "新しいタイトル",
  body: "新しい本文",
  ...o,
});
