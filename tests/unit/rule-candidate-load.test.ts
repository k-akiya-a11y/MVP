import { describe, expect, it } from "vitest";
import { CandidateLoadError, CANDIDATE_LOAD_FAILED_MESSAGE, loadCandidateSource } from "@/lib/rules/candidate-load";
import { CID, fakeClient, fail, masterRows, OTHER_CID, SECRET } from "../fixtures/rule-editor";
import { candidateScenario, entry, KEY, stableEntries } from "../fixtures/rule-candidate";

const q = { key: KEY, direction: "expense" as const, accountId: 100 };

describe("新規ルール画面の元データ", () => {
  it("最新の過去仕訳の候補と完全に一致するときだけ ready。候補の事実と有効な税区分だけを返す", async () => {
    const { client, calls } = fakeClient(candidateScenario());
    const r = await loadCandidateSource(client, CID, q);
    expect(r).toMatchObject({
      kind: "ready",
      candidate: { partnerKey: KEY, direction: "expense", accountItemId: 100, count: 2 },
      account: { id: 100, name: "消耗品費" },
      taxOptions: [{ id: 10, name: "課税仕入10%" }],
    });
    // 税区分に既定値はなく、読取だけ
    expect(calls.some((c) => c.ops.some((o) => ["insert", "update", "delete", "upsert"].includes(o.op)))).toBe(false);
  });

  it("1件だけの候補も ready（警告は画面で出す）", async () => {
    const { client } = fakeClient(candidateScenario({ entries: [entry("p1")] }));
    expect(await loadCandidateSource(client, CID, q)).toMatchObject({ kind: "ready", candidate: { count: 1 } });
  });

  it("候補が変わった（科目が複数・別科目・キーなし・向き違い・空白違い）ときは blocked", async () => {
    const cases = [
      { entries: [...stableEntries(), entry("p3", { account_item_id: 200 })] },
      { entries: stableEntries().map((e) => ({ ...e, account_item_id: 200 })) },
      { entries: stableEntries().map((e) => ({ ...e, partner_key: null })) },
      { entries: stableEntries().map((e) => ({ ...e, direction: "income" })) },
      { entries: stableEntries().map((e) => ({ ...e, partner_key: " ACME" })) },
      { entries: [] },
    ];
    for (const c of cases) {
      const { client } = fakeClient(candidateScenario(c));
      expect(await loadCandidateSource(client, CID, q), JSON.stringify(c)).toMatchObject({ kind: "blocked", reason: "candidate_missing" });
    }
  });

  it("科目が有効なマスタにない（無効・欠落）ときは blocked", async () => {
    const masters = masterRows().filter((m) => m.freee_id !== 100);
    const { client } = fakeClient(candidateScenario({ masters }));
    expect(await loadCandidateSource(client, CID, q)).toMatchObject({ kind: "blocked", reason: "account_unavailable" });
    const unavailable = masterRows().map((m) => (m.freee_id === 100 ? { ...m, available: false } : m));
    const second = fakeClient(candidateScenario({ masters: unavailable }));
    expect(await loadCandidateSource(second.client, CID, q)).toMatchObject({ kind: "blocked", reason: "account_unavailable" });
  });

  it("顧客が見えない（権限外・存在しない）ときは null", async () => {
    const { client } = fakeClient(candidateScenario({ customer: null }));
    expect(await loadCandidateSource(client, CID, q)).toBeNull();
  });

  it("他の顧客の行が混ざる・読込失敗は、中身を出さない固定文の例外にする", async () => {
    const foreign = fakeClient(candidateScenario({ entries: [entry("x", { customer_id: OTHER_CID })] }));
    await expect(loadCandidateSource(foreign.client, CID, q)).rejects.toBeInstanceOf(CandidateLoadError);
    const broken = fakeClient(() => fail(SECRET));
    const err = await loadCandidateSource(broken.client, CID, q).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CandidateLoadError);
    expect((err as Error).message).toBe(CANDIDATE_LOAD_FAILED_MESSAGE);
    expect((err as Error).message).not.toContain("sk-secret");
  });
});
