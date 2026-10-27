import { describe, expect, it } from "vitest";
import { loadNoteCreateSource, NOTE_CREATE_LOAD_FAILED_MESSAGE, NoteCreateLoadError } from "@/lib/notes/create-load";
import { CID, fail, fakeClient, ok, OTHER_CID, SECRET } from "../fixtures/note-editor";

describe("新規メモ画面の読込（読取専用）", () => {
  it("見える顧客を返し、顧客の1回の読込だけをする（書込なし）", async () => {
    const { client, calls } = fakeClient(() => ok({ id: CID, name: "テスト商事" }));
    expect(await loadNoteCreateSource(client, CID)).toEqual({ id: CID, name: "テスト商事" });
    expect(calls.map((c) => c.table)).toEqual(["customers"]);
    expect(calls[0]!.ops.some((o) => ["insert", "update", "delete", "upsert"].includes(o.op))).toBe(false);
  });

  it("顧客が見えない（null）、または UUID でない顧客IDは null。後者は問合せもしない", async () => {
    const hidden = fakeClient(() => ok(null));
    expect(await loadNoteCreateSource(hidden.client, CID)).toBeNull();
    const bad = fakeClient(() => ok({ id: CID, name: "x" }));
    expect(await loadNoteCreateSource(bad.client, "not-a-uuid")).toBeNull();
    expect(bad.calls).toHaveLength(0);
  });

  it("別の顧客の行が返る・形式不正・SDK のエラーは、中身を含まない固定文の例外にする", async () => {
    for (const reply of [() => ok({ id: OTHER_CID, name: "他社" }), () => ok({ id: CID }), () => ok(undefined), () => fail(SECRET)]) {
      const { client } = fakeClient(reply);
      const error = await loadNoteCreateSource(client, CID).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NoteCreateLoadError);
      expect((error as Error).message).toBe(NOTE_CREATE_LOAD_FAILED_MESSAGE);
      expect((error as Error).message).not.toContain("sk-secret");
    }
  });
});
