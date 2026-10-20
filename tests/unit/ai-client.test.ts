import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { claudeJournalAi } from "@/lib/ai/client";
import { buildJournalPrompt } from "@/lib/ai/prompt";
import { searchPastEntries } from "@/lib/retrieval/search";
import { JOURNAL_MODEL, JOURNAL_PROMPT_VERSION } from "@/lib/ai/version";
import { sampleContext, txn } from "../fixtures/proposal-context";

const validJson = JSON.stringify({
  decision: "proposal",
  account_item_id: 105,
  tax_code: 21,
  partner_id: 302,
  item_id: null,
  section_id: 401,
  tag_ids: [],
  description: "11月分 家賃",
  reason: "過去と同じ",
  unknowns: [],
  fixed_asset_possible: false,
  officer_or_personal: false,
});

function fakeClient(response: Record<string, unknown>) {
  const create = vi.fn(async () => ({
    model: JOURNAL_MODEL,
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
    content: [{ type: "text", text: validJson }],
    ...response,
  }));
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

function prompt() {
  const ctx = sampleContext();
  const t = txn();
  return buildJournalPrompt({
    customer: ctx.customer,
    masters: ctx.masters,
    notes: ctx.notes,
    txn: t,
    walletName: "サンプル銀行",
    past: searchPastEntries(t, ctx.pastEntries),
  });
}

describe("claudeJournalAi", () => {
  it("固定したモデルで、ツールなし・構造化出力で呼ぶ", async () => {
    const { client, create } = fakeClient({});
    const result = await claudeJournalAi(client)(prompt());
    expect(result).toMatchObject({ status: "ok", model: JOURNAL_MODEL, promptVersion: JOURNAL_PROMPT_VERSION });
    const params = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(params.model).toBe(JOURNAL_MODEL);
    expect(params).not.toHaveProperty("tools");
    expect(params).not.toHaveProperty("fallbacks");
    expect(params.output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
    // 1000×2 + 200×10 + 3000×0.2 = 4600
    expect(result.usage.costUsdMicros).toBe(4600);
  });

  it("断られたら refused を返す", async () => {
    const { client } = fakeClient({ stop_reason: "refusal", stop_details: { category: "general_harms" }, content: [] });
    expect(await claudeJournalAi(client)(prompt())).toMatchObject({ status: "refused", detail: "general_harms" });
  });

  it("形式に合わない回答は invalid", async () => {
    const { client } = fakeClient({ content: [{ type: "text", text: '{"decision":"maybe"}' }] });
    expect(await claudeJournalAi(client)(prompt())).toMatchObject({ status: "invalid" });
  });

  it("途切れた回答は truncated", async () => {
    const { client } = fakeClient({ stop_reason: "max_tokens", content: [{ type: "text", text: "{" }] });
    expect(await claudeJournalAi(client)(prompt())).toMatchObject({ status: "truncated" });
  });
});
