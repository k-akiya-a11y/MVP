import { claudeJournalAi } from "@/lib/ai/client";
import { runProposalJob } from "@/lib/proposals/run";
import { supabaseProposalStore } from "@/lib/proposals/store";
import { createServiceClient } from "@/lib/supabase/server";

/** 定期処理: 未判定の明細に仕訳候補を作る。読取と判断ログの記録だけで、freee への書込はしない */
export async function proposeJournalEntriesJob() {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  return runProposalJob({ store: supabaseProposalStore(createServiceClient()), ai: claudeJournalAi(), today });
}
