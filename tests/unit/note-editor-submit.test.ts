import { describe, expect, it } from "vitest";
import { submitNoteVersion, UNKNOWN_OUTCOME_MESSAGE } from "@/lib/notes/editor-submit";
import {
  arg,
  CID,
  fail,
  fakeClient,
  has,
  noteRow,
  noteScenario,
  NID,
  OTHER_CID,
  ok,
  SECRET,
  USER,
  validNoteInput,
  type Call,
} from "../fixtures/note-editor";

// 合成テスト: 実 DB・RLS・実際の同時実行は通らない（実 Postgres での確認は未実施）
const inserts = (calls: Call[]) => calls.filter((c) => has(c, "insert"));
const writes = (calls: Call[]) => calls.filter((c) => has(c, "insert") || has(c, "update") || has(c, "delete") || has(c, "upsert"));

describe("既存メモの新しい版の保存", () => {
  it("版 expected+1 を、作成者=ログイン中のユーザーで追加する（親・既存の版は更新も削除もしない）", async () => {
    const { client, calls, getUser } = fakeClient(noteScenario());
    const result = await submitNoteVersion(client, validNoteInput());
    expect(result).toMatchObject({ ok: true, noteId: NID, version: 3, status: "active" });
    expect(result.message).toContain(NID);
    expect(getUser).toHaveBeenCalledTimes(1);

    const w = writes(calls);
    expect(w).toHaveLength(1);
    expect(w[0]!.table).toBe("customer_note_versions");
    expect(w[0]!.ops.map((o) => o.op)).toEqual(["insert", "select", "single"]);
    expect(arg(w[0]!, "insert")).toEqual({
      note_id: NID,
      version: 3,
      customer_id: CID,
      status: "active",
      title: "新しいタイトル",
      body: "新しい本文",
      created_by: USER,
    });
    expect(calls.some((c) => has(c, "update") || has(c, "delete") || has(c, "upsert"))).toBe(false);
    expect(calls.some((c) => c.table === "customer_notes" && writes([c]).length > 0)).toBe(false);
  });

  it("無効化（新しい版として inactive を追加）。以前の版を消さず、同じ版番号を書かない", async () => {
    const { client, calls } = fakeClient(noteScenario({ versions: [noteRow({ version: 7 })] }));
    const result = await submitNoteVersion(client, validNoteInput({ expectedVersion: 7, status: "inactive" }));
    expect(result).toMatchObject({ ok: true, version: 8, status: "inactive" });
    expect(arg(inserts(calls)[0]!, "insert")).toMatchObject({ version: 8, status: "inactive" });
  });

  it("読込は顧客で絞り、親メモ・最新の版も note_id と customer_id を明示する", async () => {
    const { client, calls } = fakeClient(noteScenario());
    await submitNoteVersion(client, validNoteInput());
    const read = calls.find((c) => c.table === "customer_note_versions" && !has(c, "insert"))!;
    expect(read.ops.map((o) => o.op)).toEqual(["select", "eq", "eq", "order", "limit"]);
    expect(read.ops.filter((o) => o.op === "eq").map((o) => o.args)).toEqual([["note_id", NID], ["customer_id", CID]]);
    expect(arg(read, "order", 1)).toEqual({ ascending: false });
    const parent = calls.find((c) => c.table === "customer_notes")!;
    expect(parent.ops.filter((o) => o.op === "eq").map((o) => o.args)).toEqual([["id", NID], ["customer_id", CID]]);
  });

  it("未ログインなら書込も読込もしない。ログイン確認の例外でも保存せず内部情報を返さない", async () => {
    const anon = fakeClient(noteScenario(), { user: null });
    expect(await submitNoteVersion(anon.client, validNoteInput())).toMatchObject({ ok: false, outcome: "not_saved", code: "unauthenticated" });
    expect(anon.calls).toHaveLength(0);

    const broken = fakeClient(noteScenario(), { getUserThrows: true });
    const result = await submitNoteVersion(broken.client, validNoteInput());
    expect(result).toMatchObject({ ok: false, outcome: "not_saved", code: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("sk-secret");
    expect(broken.calls).toHaveLength(0);

    const badId = fakeClient(noteScenario(), { user: { id: "not-a-uuid" } });
    expect(await submitNoteVersion(badId.client, validNoteInput())).toMatchObject({ ok: false, code: "unavailable" });
    expect(writes(badId.calls)).toHaveLength(0);
  });

  it("入力に紛れた作成者・版・顧客の上書きは、DB に触れず拒否する", async () => {
    for (const extra of [{ createdBy: OTHER_CID }, { created_by: OTHER_CID }, { version: 99 }, { customer_id: OTHER_CID }, { source: "staff" }]) {
      const { client, calls } = fakeClient(noteScenario());
      expect(await submitNoteVersion(client, validNoteInput(extra)), JSON.stringify(extra)).toMatchObject({ ok: false, outcome: "not_saved", code: "invalid" });
      expect(calls).toHaveLength(0);
    }
  });

  it("不正な入力（有効化の空タイトル・範囲外の版・形の違い）は DB に触れず拒否する", async () => {
    for (const input of [validNoteInput({ title: " " }), validNoteInput({ body: "" }), validNoteInput({ expectedVersion: 0 }), validNoteInput({ status: "proposed" }), null, "x"]) {
      const { client, calls } = fakeClient(noteScenario());
      expect(await submitNoteVersion(client, input)).toMatchObject({ ok: false, outcome: "not_saved", code: "invalid" });
      expect(calls).toHaveLength(0);
    }
  });

  it("保存済みの空白だけ・長いメモでも無効化でき、内容は変えずに保存する", async () => {
    const long = "あ\r\n ".repeat(5000);
    for (const [title, body] of [[" ", "\n"], [long, long]]) {
      const { client, calls } = fakeClient(noteScenario({ versions: [noteRow({ title, body })] }));
      expect(await submitNoteVersion(client, validNoteInput({ status: "inactive", title, body }))).toMatchObject({ ok: true, version: 3, status: "inactive" });
      expect(arg(inserts(calls)[0]!, "insert")).toMatchObject({ title, body });
    }
  });

  it("見えない顧客・他の顧客の親メモ・版は保存しない", async () => {
    const cases: [string, unknown, string][] = [
      ["hidden customer", noteScenario({ customer: null }), "not_found"],
      ["no parent", noteScenario({ parent: null }), "not_found"],
      ["foreign parent", noteScenario({ parent: { id: NID, customer_id: OTHER_CID } }), "unavailable"],
      ["foreign customer row", noteScenario({ customer: { id: OTHER_CID, name: "他社" } }), "unavailable"],
      ["foreign version", noteScenario({ versions: [noteRow({ customer_id: OTHER_CID })] }), "unavailable"],
      ["other note version", noteScenario({ versions: [noteRow({ note_id: "77777777-7777-4777-8777-777777777777" })] }), "unavailable"],
      ["no versions", noteScenario({ versions: [] }), "unavailable"],
      ["malformed version", noteScenario({ versions: [noteRow({ status: "proposed" })] }), "unavailable"],
    ];
    for (const [name, handler, code] of cases) {
      const { client, calls } = fakeClient(handler as Parameters<typeof fakeClient>[0]);
      expect(await submitNoteVersion(client, validNoteInput()), name).toMatchObject({ ok: false, outcome: "not_saved", code });
      expect(writes(calls), name).toHaveLength(0);
    }
  });

  it("編集元の版が古い・先走っているときは保存しない（最新の版と比べる）", async () => {
    const stale = fakeClient(noteScenario({ versions: [noteRow({ version: 5 })] }));
    const result = await submitNoteVersion(stale.client, validNoteInput({ expectedVersion: 2 }));
    expect(result).toMatchObject({ ok: false, outcome: "not_saved", code: "stale" });
    expect(result.message).toContain("版2");
    expect(result.message).toContain("版5");
    expect(writes(stale.calls)).toHaveLength(0);

    const ahead = fakeClient(noteScenario());
    expect(await submitNoteVersion(ahead.client, validNoteInput({ expectedVersion: 3 }))).toMatchObject({ code: "stale" });
    expect(writes(ahead.calls)).toHaveLength(0);
  });

  it("最新が無効の版でも、明示した編集元と一致すれば有効の新しい版として保存できる", async () => {
    const { client } = fakeClient(noteScenario({ versions: [noteRow({ status: "inactive" })] }));
    expect(await submitNoteVersion(client, validNoteInput({ status: "active" }))).toMatchObject({ ok: true, version: 3, status: "active" });
  });

  it("同じ版の重複 INSERT（23505）は競合として返し、再試行しない", async () => {
    const { client, calls } = fakeClient(noteScenario({ insert: () => fail('duplicate key value violates unique constraint "customer_note_versions_pkey"', "23505") }));
    const result = await submitNoteVersion(client, validNoteInput());
    expect(result).toMatchObject({ ok: false, outcome: "not_saved", code: "conflict" });
    expect(JSON.stringify(result)).not.toContain("pkey");
    expect(inserts(calls)).toHaveLength(1);
  });

  it("権限・制約による拒否は保存していないと返し、内部のメッセージを出さない", async () => {
    const cases: [string, string][] = [["42501", "denied"], ["23514", "rejected"], ["23503", "rejected"], ["22021", "rejected"], ["P0001", "rejected"]];
    for (const [code, expected] of cases) {
      const { client, calls } = fakeClient(noteScenario({ insert: () => fail(SECRET, code) }));
      const result = await submitNoteVersion(client, validNoteInput());
      expect(result, code).toMatchObject({ ok: false, outcome: "not_saved", code: expected });
      expect(JSON.stringify(result)).not.toContain("sk-secret");
      expect(inserts(calls)).toHaveLength(1);
    }
  });

  it("通信失敗・応答の欠落・食い違う戻り値・コードのないエラーは結果不明とし、再送しない", async () => {
    const variants: Array<(c: Call) => ReturnType<ReturnType<typeof noteScenario>>> = [
      () => {
        throw new Error(SECRET);
      },
      () => Promise.reject(new Error(SECRET)),
      () => fail("TypeError: fetch failed " + SECRET, ""),
      () => fail(SECRET),
      () => fail(SECRET, "PGRST116"),
      () => fail(SECRET, "57014"),
      () => ok(null),
      () => ok("not a row"),
      () => ok(noteRow({ version: 9, status: "active" })),
      () => ok(noteRow({ version: 3, status: "inactive" })),
      () => ok(noteRow({ version: 3, status: "active", created_by: OTHER_CID, title: "新しいタイトル", body: "新しい本文" })),
      () => ok(noteRow({ version: 3, status: "active", customer_id: OTHER_CID, title: "新しいタイトル", body: "新しい本文" })),
      () => ok(noteRow({ version: 3, status: "active", title: "別のタイトル", body: "新しい本文" })),
      () => ok(noteRow({ version: 3, status: "active", title: "新しいタイトル", body: "切れた" })),
    ];
    for (const [i, insert] of variants.entries()) {
      const { client, calls } = fakeClient(noteScenario({ insert }));
      const result = await submitNoteVersion(client, validNoteInput());
      expect(result, `variant ${i}`).toEqual({ ok: false, outcome: "unknown", code: "unknown", message: UNKNOWN_OUTCOME_MESSAGE });
      expect(result.message).toContain("保存されていない、とは言い切れません");
      expect(inserts(calls)).toHaveLength(1);
    }
  });

  it("保存前の読込の失敗は、内部のメッセージを出さず、保存していないと返す", async () => {
    for (const table of ["customers", "customer_notes", "customer_note_versions"]) {
      const base = noteScenario();
      const { client, calls } = fakeClient((c) => (c.table === table && !has(c, "insert") ? fail(SECRET, "XX000") : base(c)));
      const result = await submitNoteVersion(client, validNoteInput());
      expect(result, table).toMatchObject({ ok: false, outcome: "not_saved", code: "unavailable" });
      expect(JSON.stringify(result)).not.toContain("sk-secret");
      expect(writes(calls)).toHaveLength(0);
    }
  });

  it("存在しない顧客IDを名乗っても、権限の範囲（RLS で見えない）で拒否され書込しない", async () => {
    const { client, calls } = fakeClient(noteScenario({ customer: null }));
    expect(await submitNoteVersion(client, validNoteInput({ customerId: OTHER_CID }))).toMatchObject({ ok: false, code: "not_found" });
    expect(writes(calls)).toHaveLength(0);
  });
});
