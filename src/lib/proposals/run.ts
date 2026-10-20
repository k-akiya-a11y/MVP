import type { JournalAi } from "../ai/client";
import { toAiDecisionRow } from "../audit/decision-log";
import { proposeForTransaction, type CustomerContext } from "./propose";
import type { ProposalStore } from "./store";

export type ProposalRunResult = {
  processed: number;
  byConfidence: { high: number; medium: number; low: number };
  failures: { bankTransactionId: string; error: string }[];
};

/**
 * 未判定の明細に仕訳候補を作り、AI判断ログに記録する（Vercel Cron から呼ぶ）。
 * 1件失敗しても残りは続ける。失敗した明細は「未判定」のまま残り、次回また判定する。
 */
export async function runProposalJob(
  deps: { store: ProposalStore; ai: JournalAi; today: string },
  limit = 200,
): Promise<ProposalRunResult> {
  const txns = await deps.store.listPendingTransactions(limit);
  const contexts = new Map<string, CustomerContext>();
  const result: ProposalRunResult = { processed: 0, byConfidence: { high: 0, medium: 0, low: 0 }, failures: [] };

  for (const txn of txns) {
    try {
      let ctx = contexts.get(txn.customerId);
      if (!ctx) {
        ctx = await deps.store.loadCustomerContext(txn.customerId, deps.today);
        contexts.set(txn.customerId, ctx);
      }
      const draft = await proposeForTransaction(ctx, txn, deps.ai);
      await deps.store.recordDecision(toAiDecisionRow(draft));
      result.processed++;
      result.byConfidence[draft.confidence.level]++;
    } catch (error) {
      result.failures.push({ bankTransactionId: txn.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
