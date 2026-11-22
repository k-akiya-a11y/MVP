import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { claudeJournalAi, type AiCallResult } from "@/lib/ai/client";
import { JOURNAL_PROMPT_VERSION } from "@/lib/ai/version";
import { toAiDecisionRow } from "@/lib/audit/decision-log";
import { proposeForTransaction } from "@/lib/proposals/propose";
import { sampleContext, txn } from "../fixtures/proposal-context";

// AI の回答が「JSON としては正しいが、文字列に NUL（U+0000）を含む」場合の扱い。
// PostgreSQL の text / jsonb は NUL を保存できないので、そのまま判断ログに入れると記録の書込みが失敗し、再試行で AI が繰り返し呼ばれる。
// 実 API・実 DB・SDK のネットワークは使わない（messages.create をモックに差し替える）。架空データのみ。

const NUL = "\u0000";
const MODEL = "claude-test-model-snapshot";
const LEAK = "漏れてはいけない架空の摘要XYZ";

const base = {
  decision: "proposal",
  account_item_id: 105,
  tax_code: 21,
  partner_id: 302,
  item_id: null,
  section_id: 401,
  tag_ids: [] as number[],
  description: "11月分 家賃",
  reason: "過去と同じ",
  unknowns: [] as string[],
  fixed_asset_possible: false,
  officer_or_personal: false,
};

type Output = typeof base | Record<string, unknown>;

/** JSON.stringify は NUL を \u0000 の6文字に書くので、JSON.parse した後の値には本物の NUL が入る（= JSON としては正しい回答） */
function fakeClient(output: Output) {
  const create = vi.fn(async () => ({
    model: MODEL,
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
    content: [{ type: "text", text: JSON.stringify(output) }],
  }));
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

/** 本物の claudeJournalAi を通し、その結果を記録しておく（proposeForTransaction がそのまま使う） */
async function run(output: Output) {
  const { client, create } = fakeClient(output);
  const real = claudeJournalAi(client);
  const results: AiCallResult[] = [];
  const draft = await proposeForTransaction(sampleContext(), txn(), async (prompt) => {
    const r = await real(prompt);
    results.push(r);
    return r;
  });
  return { draft, row: toAiDecisionRow(draft), result: results[0]!, aiCalls: results.length, create };
}

/** 値（キーを含む）のどこかに本物の NUL を含む文字列があるか */
function containsNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes(NUL);
  if (Array.isArray(value)) return value.some(containsNul);
  if (value instanceof Map) return [...value].some(containsNul);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([k, v]) => k.includes(NUL) || containsNul(v));
  }
  return false;
}

const nulVariants = [
  ["先頭", `${NUL}${LEAK}`],
  ["途中", `${LEAK.slice(0, 4)}${NUL}${LEAK.slice(4)}`],
  ["末尾", `${LEAK}${NUL}`],
  ["NUL だけ", NUL],
] as const;

const cases = [
  ...nulVariants.map(([pos, v]) => ({ name: `description の${pos}`, output: { ...base, description: v } })),
  ...nulVariants.map(([pos, v]) => ({ name: `reason の${pos}`, output: { ...base, reason: v } })),
  ...nulVariants.map(([pos, v]) => ({ name: `unknowns の${pos}`, output: { ...base, unknowns: ["正常な不明点", v] } })),
  { name: "unknowns の先頭の要素", output: { ...base, unknowns: [`${LEAK}${NUL}`, "正常な不明点"] } },
  // cannot_decide でも判断ログに入る文字列なので同じ
  {
    name: "cannot_decide の description",
    output: { ...base, decision: "cannot_decide", account_item_id: null, tax_code: null, partner_id: null, section_id: null, description: `${LEAK}${NUL}` },
  },
  {
    name: "cannot_decide の reason",
    output: { ...base, decision: "cannot_decide", account_item_id: null, tax_code: null, partner_id: null, section_id: null, reason: `${LEAK}${NUL}` },
  },
  {
    name: "cannot_decide の unknowns",
    output: { ...base, decision: "cannot_decide", account_item_id: null, tax_code: null, partner_id: null, section_id: null, unknowns: [`${LEAK}${NUL}`] },
  },
];

describe("AI の回答に NUL（U+0000）がある場合", () => {
  describe.each(cases)("$name", ({ output }) => {
    it("claudeJournalAi が invalid にし、モデル・プロンプトの版・使用量は残す", async () => {
      const { result, create } = await run(output);
      expect(create).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("invalid");
      expect(result).not.toHaveProperty("output");
      expect(result.model).toBe(MODEL);
      expect(result.promptVersion).toBe(JOURNAL_PROMPT_VERSION);
      expect(result.usage).toEqual({
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 3000,
        cacheWriteTokens: 0,
        costUsdMicros: 4600,
      });
    });

    it("detail は固定の安全な文言で、NUL も回答の本文も含まない", async () => {
      const { result } = await run(output);
      if (result.status === "ok") throw new Error("invalid のはず");
      expect(result.detail).toContain("NUL");
      expect(result.detail).not.toContain(NUL);
      expect(result.detail).not.toContain(LEAK);
      expect(result.detail).not.toContain(LEAK.slice(0, 4));
      expect(result.detail).not.toContain("正常な不明点");
      expect(result.detail).not.toContain("過去と同じ");
      expect(result.detail).not.toContain("11月分");
    });

    it("提案も確信度「中」以上も作らず、判断ログの行に本物の NUL が入らない", async () => {
      const { draft, row, aiCalls } = await run(output);
      expect(aiCalls).toBe(1);
      expect(draft.proposal).toBeNull();
      expect(draft.confidence.level).toBe("low");
      expect(row.proposal).toBeNull();
      expect(row.confidence).toBe("low");
      expect(row.ai_output).toBeNull();
      expect(row.ai_reason).toBeNull();
      // 記録される不明点は「使えない」旨と固定の detail だけ
      expect(row.ai_unknowns).toHaveLength(1);
      expect(row.ai_unknowns[0]).toMatch(/^AI の回答を使えません（invalid: .*NUL.*）$/);
      // 行全体（transaction_snapshot・confidence_breakdown を含む）のどこにも本物の NUL がない
      expect(containsNul(row)).toBe(false);
      expect(containsNul(draft)).toBe(false);
      // 回答の本文は判断ログに写らない
      expect(JSON.stringify(row)).not.toContain(LEAK);
      expect(JSON.stringify(row)).not.toContain(LEAK.slice(0, 4));
      // 使用量・モデル・版は行に残る（費用の記録が欠けない）
      expect(row.model).toBe(MODEL);
      expect(row.prompt_version).toBe(JOURNAL_PROMPT_VERSION);
      expect(row.input_tokens).toBe(1000);
      expect(row.output_tokens).toBe(200);
      expect(row.cache_read_tokens).toBe(3000);
      expect(row.cache_write_tokens).toBe(0);
      expect(row.cost_usd_micros).toBe(4600);
    });
  });

  it("どの項目・どの位置の NUL でも detail は同じ固定文言（内容で変わらない）", async () => {
    const details = new Set<string>();
    for (const { output } of cases) {
      const { result } = await run(output);
      if (result.status === "ok") throw new Error("invalid のはず");
      details.add(result.detail);
    }
    expect(details.size).toBe(1);
  });

  it("NUL が複数の項目にあっても 1 件の invalid（使用量は二重に数えない）", async () => {
    const { result, row } = await run({ ...base, description: `a${NUL}`, reason: `b${NUL}`, unknowns: [`c${NUL}`] });
    expect(result.status).toBe("invalid");
    expect(row.ai_unknowns).toHaveLength(1);
    expect(row.cost_usd_micros).toBe(4600);
    expect(containsNul(row)).toBe(false);
  });
});

describe("NUL がない回答は従来どおり", () => {
  it("日本語・改行を含む description / reason / unknowns はそのまま受け付け、一文字も変えない", async () => {
    const output = {
      ...base,
      description: "11月分\n家賃（本社）",
      reason: "過去6件と同じ。\n取引先は不動産会社",
      unknowns: ["請求書の宛名を確認したい\n（担当者）", "別の不明点"],
    };
    const { result, draft, row } = await run(output);
    expect(result).toMatchObject({ status: "ok", model: MODEL, promptVersion: JOURNAL_PROMPT_VERSION });
    if (result.status !== "ok") throw new Error("ok のはず");
    expect(result.output.description).toBe(output.description);
    expect(result.output.reason).toBe(output.reason);
    expect(result.output.unknowns).toEqual(output.unknowns);
    expect(draft.proposal?.description).toBe(output.description);
    expect(row.proposal?.description).toBe(output.description);
    expect(row.ai_reason).toBe(output.reason);
    expect(row.ai_unknowns).toEqual(output.unknowns);
    expect(row.ai_output).toEqual(output);
    expect(row.cost_usd_micros).toBe(4600);
    expect(containsNul(row)).toBe(false);
  });

  it("文字としての「\\u0000」（バックスラッシュ + u0000 の6文字）は NUL ではないので受け付ける", async () => {
    const literal = "\\u0000";
    expect(literal).toHaveLength(6);
    const output = { ...base, description: `摘要${literal}`, reason: `理由${literal}`, unknowns: [`不明${literal}`] };
    const { result, draft, row } = await run(output);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("ok のはず");
    expect(result.output.description).toBe(`摘要${literal}`);
    expect(result.output.reason).toBe(`理由${literal}`);
    expect(result.output.unknowns).toEqual([`不明${literal}`]);
    expect(draft.proposal?.description).toBe(`摘要${literal}`);
    expect(row.ai_reason).toBe(`理由${literal}`);
    expect(row.ai_unknowns).toEqual([`不明${literal}`]);
    expect(containsNul(row)).toBe(false);
  });

  it("cannot_decide で NUL がなければ従来どおり ok のまま理由と不明点を残す", async () => {
    const output = {
      ...base,
      decision: "cannot_decide",
      account_item_id: null,
      tax_code: null,
      partner_id: null,
      section_id: null,
      reason: "判断材料が足りない",
      unknowns: ["用途が不明"],
    };
    const { result, draft, row } = await run(output);
    expect(result.status).toBe("ok");
    expect(draft.proposal).toBeNull();
    expect(row.ai_reason).toBe("判断材料が足りない");
    expect(row.ai_unknowns).toEqual(["用途が不明"]);
    expect(containsNul(row)).toBe(false);
  });
});
