import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aiJournalOutputSchema } from "@/lib/ai/schema";
import { proposeForTransaction } from "@/lib/proposals/propose";
import { MOCK_MODEL, mockJournalAi, mockJournalOutput } from "../integration/mock-journal-ai";
import { sampleContext, txn } from "../fixtures/proposal-context";

// 実結合の確認用の偽のモデル（tests/integration/mock-journal-ai.ts）。本物の AI を呼ばず、決まった規則だけで答えること
describe("検証用の偽のモデル", () => {
  it("Claude API の SDK も本物の AI クライアントも、実行時に import しない（費用が発生する経路を持たない。型だけは使う）", () => {
    const src = readFileSync("tests/integration/mock-journal-ai.ts", "utf8");
    const runtimeImports = src.split(/\r?\n/).filter((l) => l.startsWith("import ") && !l.startsWith("import type "));
    expect(runtimeImports).toEqual(['import { z } from "zod";']);
    expect(src).not.toContain("claudeJournalAi");
  });

  it("アプリのコード（src/）から使われていない", () => {
    const job = readFileSync("src/jobs/propose-journal-entries.ts", "utf8");
    expect(job).not.toContain("mock");
  });

  it("過去仕訳の最多の組合せの代表例を、回答の形式どおりに返し、判断ログで本物と区別できる", async () => {
    const ctx = sampleContext();
    const t = txn({ id: "t1" });
    let reply: Awaited<ReturnType<typeof mockJournalAi>> | undefined;
    const draft = await proposeForTransaction(ctx, t, async (prompt) => (reply = await mockJournalAi(prompt)));
    expect(reply?.status).toBe("ok");
    if (reply?.status !== "ok") return;
    expect(aiJournalOutputSchema.safeParse(reply.output).success).toBe(true);
    expect(reply.model).toBe(MOCK_MODEL);
    expect(reply.usage.costUsdMicros).toBe(0);
    expect(draft.ai.model).toBe(MOCK_MODEL);
  });

  it("過去仕訳がなければ cannot_decide にして不明点を書く。10万円以上は固定資産の可能性あり", () => {
    const out = mockJournalOutput(
      JSON.stringify({ transaction: { amount: 132_000 }, past: { combos: [], examples: [] } }),
    );
    expect(out.decision).toBe("cannot_decide");
    expect(out.unknowns.length).toBeGreaterThan(0);
    expect(out.fixed_asset_possible).toBe(true);
  });

  it("参考データの形が違えば例外にする（黙って提案しない）", () => {
    expect(() => mockJournalOutput("{}")).toThrow();
  });
});
