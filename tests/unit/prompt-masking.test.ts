import { describe, expect, it } from "vitest";
import { buildJournalPrompt } from "@/lib/ai/prompt";
import { searchPastEntries } from "@/lib/retrieval/search";
import { sampleContext, txn } from "../fixtures/proposal-context";

// 架空の口座番号（ハイフンあり・なし）とカード番号
const SECRETS = ["7654321", "765-4321", "4111 1111 1111 1111"];

describe("AI に送る内容の伏字", () => {
  it("明細・過去仕訳・口座名・マスタ名・顧客メモのどの自由記述に口座番号があっても送らない", () => {
    const ctx = sampleContext();
    const t = { ...txn(), description: `${txn().description} 7654321` };
    const pastEntries = ctx.pastEntries.map((p) => ({
      ...p,
      bankDescription: `${p.bankDescription ?? ""} 765-4321`,
      entry: { ...p.entry, description: `${p.entry.description} 口座7654321` },
    }));
    const masters = ctx.masters.map((m) => (m.kind === "partner" ? { ...m, name: `${m.name}（口座 7654321）` } : m));
    const notes = [
      ...ctx.notes,
      { noteId: "n-secret", version: 1, title: "振込先 765-4321", body: "カード 4111 1111 1111 1111 は社長個人のもの" },
    ];
    const past = searchPastEntries(t, pastEntries);
    expect(past.examples.length).toBeGreaterThan(0);

    const sent = JSON.stringify(
      buildJournalPrompt({ customer: ctx.customer, masters, notes, txn: t, walletName: "サンプル銀行 普通 7654321", past }),
    );
    for (const secret of SECRETS) expect(sent).not.toContain(secret);
    // 伏字にしても判定に要る情報（金額・日付）は残る
    expect(sent).toContain(String(t.amount));
    expect(sent).toContain(t.txnDate);
  });

  it("顧客名は送らない", () => {
    const ctx = sampleContext();
    const t = txn();
    const sent = JSON.stringify(
      buildJournalPrompt({ ...ctx, txn: t, walletName: "サンプル銀行", past: searchPastEntries(t, ctx.pastEntries) }),
    );
    expect(sent).not.toContain(ctx.customer.name);
  });
});
