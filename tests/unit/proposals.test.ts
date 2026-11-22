import { describe, expect, it, vi } from "vitest";
import { costUsdMicros, type AiCallResult, type JournalAi } from "@/lib/ai/client";
import { maskSensitive } from "@/lib/ai/mask";
import type { AiJournalOutput } from "@/lib/ai/schema";
import { JOURNAL_MODEL, JOURNAL_PROMPT_VERSION } from "@/lib/ai/version";
import { toAiDecisionRow } from "@/lib/audit/decision-log";
import { proposeForTransaction } from "@/lib/proposals/propose";
import { runProposalJob } from "@/lib/proposals/run";
import type { ProposalStore } from "@/lib/proposals/store";
import { sampleContext, txn } from "../fixtures/proposal-context";

const usage = { inputTokens: 3000, outputTokens: 300, cacheReadTokens: 2500, cacheWriteTokens: 0, costUsdMicros: 9500 };

function aiOutput(overrides: Partial<AiJournalOutput> = {}): AiJournalOutput {
  return {
    decision: "proposal",
    account_item_id: 105,
    tax_code: 21,
    partner_id: 302,
    item_id: null,
    section_id: 401,
    tag_ids: [],
    description: "11月分 家賃",
    reason: "過去6件すべて地代家賃",
    unknowns: [],
    fixed_asset_possible: false,
    officer_or_personal: false,
    ...overrides,
  };
}

function mockAi(result: Partial<AiCallResult> & { output?: AiJournalOutput } = {}): JournalAi & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    status: "ok",
    output: aiOutput(),
    model: JOURNAL_MODEL,
    promptVersion: JOURNAL_PROMPT_VERSION,
    usage,
    ...result,
  }) as AiCallResult) as JournalAi & ReturnType<typeof vi.fn>;
}

describe("proposeForTransaction", () => {
  it("ルールに一致すれば AI を呼ばずにルールの処理を提案し、確信度は高", async () => {
    const ai = mockAi();
    const draft = await proposeForTransaction(
      sampleContext(),
      txn({ description: "ｻﾝﾌﾟﾙﾂｳｼﾝ(ｶ", amount: 9020, txnDate: "2026-10-27" }),
      ai,
    );
    expect(ai).not.toHaveBeenCalled();
    expect(draft.confidence.level).toBe("high");
    expect(draft.proposal).toEqual({
      accountItemId: 101,
      taxCode: 21,
      partnerId: 301,
      itemId: null,
      sectionId: null,
      tagIds: [],
      description: "10月分 通信料",
    });
    expect(draft.ruleVersionsUsed).toEqual([{ ruleId: "30000000-0000-4000-8000-000000000001", version: 1 }]);
    expect(draft.ai.model).toBeNull();
  });

  it("マスタにない値（存在しない部門）を含むルールは提案に使わず、確信度は低", async () => {
    const ctx = sampleContext();
    ctx.activeRules = ctx.activeRules.map((r) => ({ ...r, action: { ...r.action, sectionId: 999 } }));
    const ai = mockAi();
    const draft = await proposeForTransaction(ctx, txn({ description: "ｻﾝﾌﾟﾙﾂｳｼﾝ(ｶ", amount: 9020, txnDate: "2026-10-27" }), ai);
    expect(ai).not.toHaveBeenCalled();
    expect(draft.proposal).toBeNull();
    expect(draft.confidence.level).toBe("low");
    expect(draft.confidence.breakdown.checks).toContainEqual(
      expect.objectContaining({ id: "rule_masters", passed: false, detail: expect.stringContaining("部門 999 はマスタにありません") }),
    );
    expect(draft.confidence.breakdown.reasons[0]).toMatch(/ルールの見直しが必要/);
    // どのルールの版で止まったかは判断ログに残る
    expect(draft.ruleVersionsUsed).toEqual([{ ruleId: "30000000-0000-4000-8000-000000000001", version: 1 }]);
  });

  it("過去5件以上・一致率95%以上で AI も一致すれば高", async () => {
    const ai = mockAi();
    const draft = await proposeForTransaction(sampleContext(), txn(), ai);
    expect(ai).toHaveBeenCalledTimes(1);
    expect(draft.confidence.level).toBe("high");
    expect(draft.confidence.breakdown.past).toMatchObject({ matchType: "exact", total: 6, proposalAgreesWithMajority: true });
    expect(draft.pastEntryIds).toHaveLength(5);
    expect(draft.noteVersionsUsed).toEqual([{ noteId: "31000000-0000-4000-8000-000000000001", version: 1 }]);
  });

  it("AI の案が過去の多数派と違えば低", async () => {
    const draft = await proposeForTransaction(sampleContext(), txn(), mockAi({ output: aiOutput({ account_item_id: 102 }) }));
    expect(draft.confidence.level).toBe("low");
    expect(draft.confidence.breakdown.reasons).toContain("AI の案が過去の多数派と違う");
  });

  it("金額が過去の範囲外なら中", async () => {
    const draft = await proposeForTransaction(sampleContext(), txn({ amount: 170000 }), mockAi());
    expect(draft.confidence.level).toBe("medium");
    expect(draft.confidence.breakdown.reasons).toContain("金額が過去の範囲外");
  });

  it("過去の件数が少なければ中", async () => {
    const draft = await proposeForTransaction(
      sampleContext(),
      txn({ direction: "income", amount: 330000, description: "ﾌﾘｺﾐ ﾃｽﾄｺｷｬｸ(ｶ" }),
      mockAi({ output: aiOutput({ account_item_id: 106, tax_code: 31, partner_id: null }) }),
    );
    // 33万円は上限額（30万円）以上なので、件数より先に「常に低」が効く
    expect(draft.confidence.level).toBe("low");
    expect(draft.confidence.breakdown.forcedLow[0]).toMatch(/上限額/);

    const ctx = sampleContext();
    ctx.customer.lowConfidenceAmountThreshold = 1_000_000;
    const draft2 = await proposeForTransaction(
      ctx,
      txn({ direction: "income", amount: 330000, description: "ﾌﾘｺﾐ ﾃｽﾄｺｷｬｸ(ｶ" }),
      mockAi({ output: aiOutput({ account_item_id: 106, tax_code: 31, partner_id: null }) }),
    );
    expect(draft2.confidence.level).toBe("medium");
    expect(draft2.confidence.breakdown.reasons).toContain("過去の件数が少ない（2件）");
  });

  it("新規取引先は低（AI の案があっても）", async () => {
    const draft = await proposeForTransaction(
      sampleContext(),
      txn({ description: "ﾐﾁﾉﾄﾘﾋｷｻｷ", amount: 5000 }),
      mockAi({ output: aiOutput({ account_item_id: 102, partner_id: null }) }),
    );
    expect(draft.confidence.level).toBe("low");
    expect(draft.confidence.breakdown.reasons).toContain("新規取引先（ルールも過去仕訳もない）");
  });

  it("上限額以上はルール一致でも低", async () => {
    const draft = await proposeForTransaction(sampleContext(), txn({ description: "ｻﾝﾌﾟﾙﾂｳｼﾝ(ｶ", amount: 300000 }), mockAi());
    expect(draft.confidence.level).toBe("low");
  });

  it.each([
    ["固定資産の科目", { account_item_id: 108 }],
    ["AI が固定資産の可能性を指摘", { fixed_asset_possible: true }],
    ["AI が役員・個人の可能性を指摘", { officer_or_personal: true }],
  ])("%s なら低", async (_, overrides) => {
    const draft = await proposeForTransaction(sampleContext(), txn(), mockAi({ output: aiOutput(overrides) }));
    expect(draft.confidence.level).toBe("low");
  });

  it("要注意語（返金）があれば低", async () => {
    const draft = await proposeForTransaction(sampleContext(), txn({ description: "ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ ﾍﾝｷﾝ" }), mockAi());
    expect(draft.confidence.level).toBe("low");
  });

  it("マスタにない値を返したら提案を弾いて低", async () => {
    const draft = await proposeForTransaction(sampleContext(), txn(), mockAi({ output: aiOutput({ section_id: 999 }) }));
    expect(draft.proposal).toBeNull();
    expect(draft.confidence.level).toBe("low");
    expect(draft.ai.unknowns).toContain("部門 999 はマスタにありません");
  });

  it("AI が判断できないと答えたら低で、不明点を残す", async () => {
    const draft = await proposeForTransaction(
      sampleContext(),
      txn(),
      mockAi({ output: aiOutput({ decision: "cannot_decide", unknowns: ["家賃か保証金か不明"] }) }),
    );
    expect(draft.proposal).toBeNull();
    expect(draft.confidence.level).toBe("low");
    expect(draft.ai.unknowns).toEqual(["家賃か保証金か不明"]);
  });

  it("AI に断られたら低で、使用量は記録する", async () => {
    const ai = vi.fn(async () => ({
      status: "refused" as const,
      model: JOURNAL_MODEL,
      promptVersion: JOURNAL_PROMPT_VERSION,
      usage,
      detail: "general_harms",
    }));
    const draft = await proposeForTransaction(sampleContext(), txn(), ai);
    expect(draft.confidence.level).toBe("low");
    expect(draft.ai.usage).toEqual(usage);
    expect(draft.ai.unknowns[0]).toMatch(/refused/);
  });

  it("AI に送る摘要は口座番号を伏せ、user の参考データ JSON の中に置く（system には入れない）", async () => {
    const ai = mockAi();
    await proposeForTransaction(sampleContext(), txn({ description: "ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ 1234567" }), ai);
    const prompt = ai.mock.calls[0]![0] as Parameters<JournalAi>[0];
    const user = JSON.stringify(prompt.messages);
    expect(user).not.toContain("1234567");
    const sent = JSON.parse(prompt.messages[0]!.content as string);
    expect(sent.transaction.description).toBe("ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ *******");
    expect(JSON.stringify(prompt.system)).not.toContain("ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ");
    // 顧客データを system に置かないので、system にキャッシュ指定は付けない
    expect(prompt.system.some((b) => "cache_control" in b)).toBe(false);
  });
});

describe("AI判断ログの行", () => {
  it("AI を呼んだ判断は必須項目がすべて埋まる", async () => {
    const draft = await proposeForTransaction(sampleContext(), txn(), mockAi());
    const row = toAiDecisionRow(draft);
    for (const [key, value] of Object.entries(row)) {
      expect(value, key).not.toBeUndefined();
    }
    expect(row).toMatchObject({
      customer_id: draft.customerId,
      bank_transaction_id: "t-1",
      confidence: "high",
      model: JOURNAL_MODEL,
      prompt_version: JOURNAL_PROMPT_VERSION,
      input_tokens: 3000,
      output_tokens: 300,
      cache_read_tokens: 2500,
      cost_usd_micros: 9500,
      ai_reason: "過去6件すべて地代家賃",
    });
    expect(row.transaction_snapshot).toMatchObject({ amount: 165000, partnerKey: "サンプルフドウサン" });
    expect(row.proposal).toMatchObject({ account_item_id: 105, tax_code: 21 });
    expect(row.confidence_breakdown.checks.length).toBeGreaterThan(0);
  });
});

describe("runProposalJob", () => {
  it("全件の判断を記録し、1件失敗しても続ける", async () => {
    const recorded: unknown[] = [];
    // 1 件ずつ借りる（run は claimPendingBatch(1) を繰り返し、空で止まる）
    const queue = [txn({ id: "a" }), txn({ id: "b" }), txn({ id: "c", description: "ｻﾝﾌﾟﾙﾂｳｼﾝ(ｶ", amount: 9020 })];
    const store: ProposalStore = {
      claimPendingBatch: async (limit) => queue.splice(0, limit),
      confirmClaim: async () => true,
      releaseClaims: async () => undefined,
      loadCustomerContext: vi.fn(async () => sampleContext()),
      recordDecision: async (row) => {
        if (row.bank_transaction_id === "b") throw new Error("db down");
        recorded.push(row);
        return "d";
      },
    };
    const result = await runProposalJob({ store, ai: mockAi(), today: "2026-10-31" });
    expect(result.processed).toBe(2);
    expect(result.failures).toEqual([{ bankTransactionId: "b", error: "db down" }]);
    expect(result.byConfidence.high).toBe(2);
    expect(recorded).toHaveLength(2);
    // 文脈は明細ごとに読み直す（使い回さない）
    expect(store.loadCustomerContext).toHaveBeenCalledTimes(3);
  });
});

describe("runProposalJob: 文脈は明細ごとに読み直す", () => {
  const RULE_ID = "30000000-0000-4000-8000-000000000001";
  const NOTE_ID = "31000000-0000-4000-8000-000000000001";
  const OTHER_CUSTOMER = "10000000-0000-4000-8000-000000000002";
  const ruleTxn = (id: string, customerId?: string) =>
    txn({ id, description: "ｻﾝﾌﾟﾙﾂｳｼﾝ(ｶ", amount: 9020, txnDate: "2026-10-27", ...(customerId ? { customerId } : {}) });

  /** 1 件ずつ借りる偽のストア。文脈の読込は呼出し順に loads を使う */
  function fakeStore(queue: ReturnType<typeof txn>[], load: ProposalStore["loadCustomerContext"], extra: Partial<ProposalStore> = {}) {
    const rows: ReturnType<typeof toAiDecisionRow>[] = [];
    const released: string[][] = [];
    const store: ProposalStore = {
      claimPendingBatch: async (limit) => queue.splice(0, limit),
      confirmClaim: async () => true,
      releaseClaims: async (ids) => {
        released.push([...ids]);
      },
      loadCustomerContext: vi.fn(load),
      recordDecision: async (row) => {
        rows.push(row);
        return "d";
      },
      ...extra,
    };
    return { store, rows, released };
  }

  it("同じ顧客の次の明細は、編集・無効化されたルールを反映した最新の文脈で判定される", async () => {
    const contexts = [
      sampleContext(),
      (() => {
        const c = sampleContext();
        c.activeRules = c.activeRules.map((r) => ({ ...r, version: 2 }));
        return c;
      })(),
      (() => {
        const c = sampleContext();
        c.activeRules = [];
        return c;
      })(),
    ];
    let n = 0;
    const { store, rows } = fakeStore([ruleTxn("a"), ruleTxn("b"), ruleTxn("c")], async () => contexts[n++]!);
    const ai = mockAi();
    const result = await runProposalJob({ store, ai, today: "2026-10-31" });
    expect(result.processed).toBe(3);
    expect(store.loadCustomerContext).toHaveBeenCalledTimes(3);
    expect(rows.map((r) => r.rule_versions_used)).toEqual([
      [{ rule_id: RULE_ID, version: 1 }],
      [{ rule_id: RULE_ID, version: 2 }],
      [],
    ]);
    // ルールが無効になった 3 件目だけが AI を呼ぶ
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it("同じ顧客の次の明細は、新しく確定した過去仕訳・変更されたメモを反映する", async () => {
    const before = sampleContext();
    const after = sampleContext();
    after.pastEntries = [];
    after.notes = [{ noteId: NOTE_ID, version: 2, title: "代表者カードの私用分", body: "改訂後の本文" }];
    const contexts = [before, after];
    let n = 0;
    const { store, rows } = fakeStore([txn({ id: "a" }), txn({ id: "b" })], async () => contexts[n++]!);
    await runProposalJob({ store, ai: mockAi(), today: "2026-10-31" });
    expect(rows[0]!.past_entry_ids).toHaveLength(5);
    expect(rows[0]!.note_versions_used).toEqual([{ note_id: NOTE_ID, version: 1 }]);
    expect(rows[1]!.past_entry_ids).toEqual([]);
    expect(rows[1]!.note_versions_used).toEqual([{ note_id: NOTE_ID, version: 2 }]);
  });

  it("顧客ごとに読み、文脈は顧客の間で混ざらない（A・B・A でも毎回読む）", async () => {
    const forCustomer = (id: string, version: number) => {
      const c = sampleContext();
      c.customer.id = id;
      c.activeRules = c.activeRules.map((r) => ({ ...r, version }));
      return c;
    };
    const load = vi.fn(async (customerId: string) =>
      customerId === OTHER_CUSTOMER ? forCustomer(OTHER_CUSTOMER, 7) : forCustomer(customerId, 1),
    );
    const { store, rows } = fakeStore([ruleTxn("a"), ruleTxn("b", OTHER_CUSTOMER), ruleTxn("c")], load);
    await runProposalJob({ store, ai: mockAi(), today: "2026-10-31" });
    expect(load.mock.calls.map((c) => c[0])).toEqual([txn().customerId, OTHER_CUSTOMER, txn().customerId]);
    expect(rows.map((r) => [r.customer_id, r.rule_versions_used[0]!.version])).toEqual([
      [txn().customerId, 1],
      [OTHER_CUSTOMER, 7],
      [txn().customerId, 1],
    ]);
  });

  it("2 件目の読込が失敗したら、前の文脈も AI も使わず失敗にし、貸出しを返して続ける", async () => {
    let n = 0;
    const { store, rows, released } = fakeStore([txn({ id: "a" }), txn({ id: "b" }), txn({ id: "c" })], async () => {
      n++;
      if (n === 2) throw new Error("master read failed");
      return sampleContext();
    });
    const ai = mockAi();
    const result = await runProposalJob({ store, ai, today: "2026-10-31" });
    expect(result.failures).toEqual([{ bankTransactionId: "b", error: "master read failed" }]);
    expect(result).toMatchObject({ processed: 2, attempted: 3, truncated: false });
    expect(store.loadCustomerContext).toHaveBeenCalledTimes(3);
    expect(ai).toHaveBeenCalledTimes(2); // b には前の文脈でも AI を呼ばない
    expect(rows.map((r) => r.bank_transaction_id)).toEqual(["a", "c"]);
    expect(released).toEqual([["b"]]);
  });

  it("読込の間に予算が尽きたら、次の明細は AI を呼ばず、失敗にも数えず、貸出しを返して打ち切る", async () => {
    let t = 0;
    let n = 0;
    const { store, rows, released } = fakeStore([txn({ id: "a" }), txn({ id: "b" })], async () => {
      if (++n === 2) t += 1000; // 2 件目の読込が遅く、予算（500ms）を超えた
      return sampleContext();
    });
    const ai = mockAi();
    const result = await runProposalJob({ store, ai, today: "2026-10-31", now: () => t, budgetMs: 500 });
    expect(result).toMatchObject({ processed: 1, attempted: 2, truncated: true, failures: [] });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(rows.map((r) => r.bank_transaction_id)).toEqual(["a"]);
    expect(released).toEqual([["b"]]);
  });

  it("読込の後の所有の確認は従来どおり。奪われた明細は AI を呼ばず失敗にする", async () => {
    const { store, rows } = fakeStore(
      [txn({ id: "a" }), txn({ id: "b" })],
      async () => sampleContext(),
      { confirmClaim: async (id) => id !== "b" },
    );
    const ai = mockAi();
    const result = await runProposalJob({ store, ai, today: "2026-10-31" });
    expect(result.failures).toEqual([{ bankTransactionId: "b", error: expect.stringContaining("他の実行") }]);
    expect(ai).toHaveBeenCalledTimes(1);
    expect(rows.map((r) => r.bank_transaction_id)).toEqual(["a"]);
    expect(store.loadCustomerContext).toHaveBeenCalledTimes(2); // 読込は所有の確認より前
  });
});

describe("費用と伏字", () => {
  it("費用は整数で切り上げ", () => {
    // 1000×2 + 100×10 + 2000×0.2 + 0 = 3400 マイクロドル
    expect(costUsdMicros({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 2000, cacheWriteTokens: 0 })).toBe(3400);
    expect(costUsdMicros({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0 })).toBe(1);
  });

  it("7桁以上の数字だけ伏せる", () => {
    expect(maskSensitive("ﾌﾘｺﾐ 1234567 ｻﾝﾌﾟﾙ")).toBe("ﾌﾘｺﾐ ******* ｻﾝﾌﾟﾙ");
    expect(maskSensitive("口座 123-4567")).toBe("口座 ********");
    expect(maskSensitive("10/03 12345")).toBe("10/03 12345");
    expect(maskSensitive("ｶｰﾄﾞ 1234 5678 9012 3456")).toBe("ｶｰﾄﾞ *******************");
  });
});
