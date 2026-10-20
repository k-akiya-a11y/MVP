import type { JournalEntryFields } from "../proposals/types";
import type { DecisionDraft } from "../proposals/propose";

/** freee の取引1行分を DB（jsonb）に入れる形。キーは freee API の項目名に合わせる */
export function entryToJson(entry: JournalEntryFields) {
  return {
    account_item_id: entry.accountItemId,
    tax_code: entry.taxCode,
    partner_id: entry.partnerId,
    item_id: entry.itemId,
    section_id: entry.sectionId,
    tag_ids: entry.tagIds,
    description: entry.description,
  };
}

/**
 * AI判断ログ（ai_decisions）1行。設計書8章・CLAUDE.md 5章の必須項目をすべて埋める。
 * AI を呼ばずにルールで決めたときは、AI の項目（モデル・プロンプトの版・トークン数）は null。
 */
export function toAiDecisionRow(draft: DecisionDraft) {
  const usage = draft.ai.usage;
  return {
    customer_id: draft.customerId,
    bank_transaction_id: draft.bankTransactionId,
    transaction_snapshot: draft.transactionSnapshot,
    proposal: draft.proposal ? entryToJson(draft.proposal) : null,
    confidence: draft.confidence.level,
    confidence_breakdown: draft.confidence.breakdown,
    rule_versions_used: draft.ruleVersionsUsed.map((r) => ({ rule_id: r.ruleId, version: r.version })),
    note_versions_used: draft.noteVersionsUsed.map((n) => ({ note_id: n.noteId, version: n.version })),
    past_entry_ids: draft.pastEntryIds,
    ai_output: draft.ai.output,
    ai_reason: draft.ai.reason,
    ai_unknowns: draft.ai.unknowns,
    model: draft.ai.model,
    prompt_version: draft.ai.promptVersion,
    input_tokens: usage?.inputTokens ?? null,
    output_tokens: usage?.outputTokens ?? null,
    cache_read_tokens: usage?.cacheReadTokens ?? null,
    cache_write_tokens: usage?.cacheWriteTokens ?? null,
    cost_usd_micros: usage?.costUsdMicros ?? null,
  };
}

export type AiDecisionRow = ReturnType<typeof toAiDecisionRow>;
