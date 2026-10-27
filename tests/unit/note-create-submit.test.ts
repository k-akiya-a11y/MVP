import { describe, expect, it } from "vitest";
import { NOTE_CREATE_UNKNOWN_MESSAGE } from "@/lib/notes/create-schema";
import { createCustomerNote } from "@/lib/notes/create-submit";
import { CID, fail, NID, OTHER_CID, ok, SECRET } from "../fixtures/note-editor";
import { rpcClient, writes } from "../fixtures/rule-candidate";

// 合成テスト: 実 DB・RLS・RPC 本体は通らない（tests/db/note-create.test.ts が実 Postgres で確認する）
const customerOnly = (customer: unknown = { id: CID, name: "テスト商事" }) => () => ok(customer);
const okRpc = (c: { args: Record<string, unknown> }) => ok(c.args.p_note_id);
const input = (o: Record<string, unknown> = {}) => ({ customerId: CID, requestId: NID, title: "題名", body: "本文", ...o });

describe("新規メモの作成（サーバー側）", () => {
  it("RPC を正確な4つの引数で1回だけ呼ぶ。状態・版・作成者は送らず、テーブルへ直接書かない", async () => {
    const { client, calls, rpcCalls, getUser } = rpcClient(customerOnly(), okRpc);
    const result = await createCustomerNote(client, input({ title: " 題名 ", body: "一行目\r\n二行目\n" }));
    expect(result).toMatchObject({ ok: true, noteId: NID, version: 1, status: "inactive" });
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(rpcCalls).toEqual([
      { fn: "create_customer_note", args: { p_customer_id: CID, p_note_id: NID, p_title: " 題名 ", p_body: "一行目\r\n二行目\n" } },
    ]);
    expect(writes(calls)).toHaveLength(0);
    expect(calls.map((c) => c.table)).toEqual(["customers"]);
    expect(JSON.stringify(rpcCalls)).not.toMatch(/active|created_by|status|version/);
  });

  it("成功の文言はメモID・無効・AIにまだ使われないこと・有効化は人が行うことを伝える", async () => {
    const { client } = rpcClient(customerOnly(), okRpc);
    const r = await createCustomerNote(client, input());
    expect(r.message).toContain(NID);
    expect(r.message).toContain("「無効」の版1");
    expect(r.message).toContain("AI にはまだ使われません");
    expect(r.message).toContain("人が内容を確認して「有効」");
  });

  it("戻り値のUUIDは大文字小文字を区別せず照合する", async () => {
    const { client } = rpcClient(customerOnly(), () => ok(NID.toUpperCase()));
    expect(await createCustomerNote(client, input())).toMatchObject({ ok: true, noteId: NID });
  });

  it("不正な入力（空白だけ・余計な項目・不正なID）は DB にも RPC にもログイン確認にも触れずに拒否する", async () => {
    const bad = [
      { title: "" },
      { title: "  　\n" },
      { body: " " },
      { title: "a\u0000" },
      { status: "active" },
      { status: "inactive" },
      { version: 1 },
      { createdBy: CID },
      { requestId: "x" },
      { customerId: "x" },
    ];
    for (const o of bad) {
      const { client, calls, rpcCalls, getUser } = rpcClient(customerOnly(), okRpc);
      const r = await createCustomerNote(client, input(o));
      expect(r, JSON.stringify(o)).toMatchObject({ ok: false, outcome: "not_saved", code: "invalid" });
      expect(calls).toHaveLength(0);
      expect(rpcCalls).toHaveLength(0);
      expect(getUser).not.toHaveBeenCalled();
    }
    for (const raw of [null, undefined, "x", 1, []]) {
      const { client, rpcCalls } = rpcClient(customerOnly(), okRpc);
      expect(await createCustomerNote(client, raw)).toMatchObject({ code: "invalid" });
      expect(rpcCalls).toHaveLength(0);
    }
  });

  it("未ログイン・ログイン確認の例外では読込も RPC もしない", async () => {
    const none = rpcClient(customerOnly(), okRpc, { user: null });
    expect(await createCustomerNote(none.client, input())).toMatchObject({ outcome: "not_saved", code: "unauthenticated" });
    expect(none.calls).toHaveLength(0);
    expect(none.rpcCalls).toHaveLength(0);
    const thrown = rpcClient(customerOnly(), okRpc, { getUserThrows: true });
    const r = await createCustomerNote(thrown.client, input());
    expect(r).toMatchObject({ outcome: "not_saved", code: "unavailable" });
    expect(JSON.stringify(r)).not.toContain("sk-secret");
    expect(thrown.rpcCalls).toHaveLength(0);
  });

  it("ユーザーIDがUUIDでないときは RPC を呼ばない", async () => {
    const { client, rpcCalls } = rpcClient(customerOnly(), okRpc, { user: { id: "not-a-uuid" } });
    expect(await createCustomerNote(client, input())).toMatchObject({ code: "unavailable" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("顧客が見えない（他の担当の顧客・偽装した顧客ID）ときは RPC を呼ばない", async () => {
    const { client, rpcCalls } = rpcClient(customerOnly(null), okRpc);
    expect(await createCustomerNote(client, input({ customerId: OTHER_CID }))).toMatchObject({ outcome: "not_saved", code: "not_found" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("別の顧客の行が返る・読込のエラーは固定文で「保存していない」とし、RPC を呼ばない", async () => {
    for (const reply of [() => ok({ id: OTHER_CID, name: "他社" }), () => fail(SECRET), () => ok(undefined)]) {
      const { client, rpcCalls } = rpcClient(reply, okRpc);
      const r = await createCustomerNote(client, input());
      expect(r).toMatchObject({ outcome: "not_saved", code: "unavailable" });
      expect(JSON.stringify(r)).not.toContain("sk-secret");
      expect(rpcCalls).toHaveLength(0);
    }
  });

  it("DB が拒否したことが確かなエラーは not_saved。重複(23505)は conflict で、再試行せず既存のメモも読まない・書かない", async () => {
    const table: [string, string][] = [
      ["23505", "conflict"],
      ["42501", "denied"],
      ["P0001", "rejected"],
      ["22023", "rejected"],
      ["22004", "rejected"],
      ["23503", "rejected"],
    ];
    for (const [pg, code] of table) {
      const { client, rpcMock, calls } = rpcClient(customerOnly(), () => fail(SECRET, pg));
      const r = await createCustomerNote(client, input());
      expect(r, pg).toMatchObject({ ok: false, outcome: "not_saved", code });
      expect(JSON.stringify(r)).not.toContain("sk-secret");
      expect(rpcMock).toHaveBeenCalledTimes(1);
      expect(writes(calls)).toHaveLength(0);
      expect(calls.map((c) => c.table)).toEqual(["customers"]);
    }
  });

  it("重複の文言は、既存のメモを上書きしていないことと一覧での確認を伝える", async () => {
    const { client } = rpcClient(customerOnly(), () => fail("dup", "23505"));
    const r = await createCustomerNote(client, input());
    expect(r.message).toContain("上書きしていません");
    expect(r.message).toContain("文章メモの一覧");
  });

  it("通信失敗・コードのないエラー・応答の欠落や不一致は unknown（失敗とは言い切らず、再送しない）", async () => {
    const handlers: (() => ReturnType<typeof ok> | Promise<never>)[] = [
      () => Promise.reject(new Error(SECRET)),
      () => fail(SECRET),
      () => fail("fetch failed", "PGRST301"),
      () => fail("timeout", "57014"),
      () => ok(null),
      () => ok(undefined),
      () => ok("99999999-9999-4999-8999-999999999999"),
      () => ok({ id: NID }),
      () => ok(1),
    ];
    for (const h of handlers) {
      const { client, rpcMock } = rpcClient(customerOnly(), h);
      const r = await createCustomerNote(client, input());
      expect(r).toEqual({ ok: false, outcome: "unknown", code: "unknown", message: NOTE_CREATE_UNKNOWN_MESSAGE });
      expect(r.message).not.toContain("保存していません");
      expect(rpcMock).toHaveBeenCalledTimes(1);
    }
  });

  it("同じ入力は同じ引数になる（依頼IDを勝手に変えない）", async () => {
    const a = rpcClient(customerOnly(), okRpc);
    const b = rpcClient(customerOnly(), okRpc);
    await createCustomerNote(a.client, input());
    await createCustomerNote(b.client, input());
    expect(a.rpcCalls[0]).toEqual(b.rpcCalls[0]);
  });
});
