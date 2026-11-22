import { describe, expect, it } from "vitest";
import { loadNoteEditor, NOTE_LOAD_FAILED_MESSAGE, NoteEditorLoadError } from "@/lib/notes/editor-load";
import { PAGE_SIZE } from "@/lib/supabase/fetch-all";
import { CID, eqs, fail, fakeClient, NID, noteLoaderScenario, noteRow, OTHER_CID, SECRET } from "../fixtures/note-editor";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("rejected を期待したが成功した");
};

describe("既存メモ編集画面の読込", () => {
  it("顧客が見えないときはメモを読まずに null。顧客IDの形式が不正なら DB に触れずに null", async () => {
    const hidden = fakeClient(noteLoaderScenario({ customer: null }));
    expect(await loadNoteEditor(hidden.client, CID)).toBeNull();
    expect(hidden.calls.map((c) => c.table)).toEqual(["customers"]);

    const bad = fakeClient(noteLoaderScenario());
    expect(await loadNoteEditor(bad.client, "nope")).toBeNull();
    expect(bad.calls).toHaveLength(0);
  });

  it("現在の版を、保存されている値のまま（長い・改行入り・空白だけも含めて）返し、顧客で絞る", async () => {
    const long = "あ\r\n".repeat(20_000);
    const { client, calls } = fakeClient(
      noteLoaderScenario({ versions: [noteRow({ title: " ", body: long, status: "inactive" })] }),
    );
    const data = await loadNoteEditor(client, CID);
    expect(data?.customer).toEqual({ id: CID, name: "テスト商事" });
    expect(data?.notes).toEqual([{ noteId: NID, version: 2, status: "inactive", title: " ", body: long, createdAt: "2026-10-01T00:00:00+00:00" }]);
    for (const table of ["customer_notes", "current_customer_notes"]) {
      for (const c of calls.filter((x) => x.table === table)) expect(eqs(c)).toContain(`customer_id=${CID}`);
    }
    // 親も版も書込・更新の操作は一切ない
    expect(calls.some((c) => c.ops.some((o) => ["insert", "update", "delete", "upsert"].includes(o.op)))).toBe(false);
  });

  it("1ページ（PAGE_SIZE）を超える件数もすべて読む", async () => {
    const n = PAGE_SIZE + 5;
    const ids = Array.from({ length: n }, (_, i) => uuid(i + 1));
    const { client } = fakeClient(
      noteLoaderScenario({
        parents: ids.map((id) => ({ id, customer_id: CID })),
        versions: ids.map((id, i) => noteRow({ note_id: id, created_at: `2026-10-01T00:00:${String(i % 60).padStart(2, "0")}+00:00` })),
      }),
    );
    expect((await loadNoteEditor(client, CID))?.notes).toHaveLength(n);
  });

  it("他の顧客の行・親のない版・重複した現在の版・形式の不正は、固定文の失敗にする", async () => {
    const cases: Record<string, Parameters<typeof noteLoaderScenario>[0]> = {
      foreignParent: { parents: [{ id: NID, customer_id: OTHER_CID }] },
      foreignVersion: { versions: [noteRow({ customer_id: OTHER_CID })] },
      noParent: { parents: [] },
      duplicate: { versions: [noteRow(), noteRow({ version: 3 })] },
      badStatus: { versions: [noteRow({ status: "proposed" })] },
      badVersion: { versions: [noteRow({ version: 0 })] },
      badTitle: { versions: [noteRow({ title: null })] },
      foreignCustomer: { customer: { id: OTHER_CID, name: "他社" } },
    };
    for (const [name, t] of Object.entries(cases)) {
      const { client } = fakeClient(noteLoaderScenario(t));
      const e = await rejection(loadNoteEditor(client, CID));
      expect(e, name).toBeInstanceOf(NoteEditorLoadError);
      expect((e as Error).message).toBe(NOTE_LOAD_FAILED_MESSAGE);
    }
  });

  it("読込エラーの中身は出さない（0件とも区別される）", async () => {
    for (const table of ["customers", "customer_notes", "current_customer_notes"]) {
      const base = noteLoaderScenario();
      const { client } = fakeClient((c) => (c.table === table ? fail(SECRET, "XX000") : base(c)));
      const e = await rejection(loadNoteEditor(client, CID));
      expect(e, table).toBeInstanceOf(NoteEditorLoadError);
      expect((e as Error).message).not.toContain("sk-secret");
    }
    const empty = fakeClient(noteLoaderScenario({ parents: [], versions: [] }));
    expect((await loadNoteEditor(empty.client, CID))?.notes).toEqual([]);
  });
});
