import type { JournalEntryFields, MasterEntry, MasterKind } from "../proposals/types";
import type { AiJournalOutput } from "./schema";

export type ValidatedAiOutput =
  | { ok: true; entry: JournalEntryFields }
  | { ok: false; reason: "cannot_decide" | "not_in_master"; problems: string[] };

/**
 * AI の回答をマスタの写しと照らす（CLAUDE.md 4章: マスタにある値だけ受け付ける）。
 * 1つでもマスタにない ID があれば提案全体を弾く。
 */
export function validateAgainstMasters(output: AiJournalOutput, masters: readonly MasterEntry[]): ValidatedAiOutput {
  if (output.decision === "cannot_decide") {
    return { ok: false, reason: "cannot_decide", problems: [] };
  }
  const has = (kind: MasterKind, id: number) => masters.some((m) => m.kind === kind && m.id === id);
  const problems: string[] = [];
  if (output.account_item_id === null) problems.push("勘定科目が空です");
  else if (!has("account_item", output.account_item_id)) problems.push(`勘定科目 ${output.account_item_id} はマスタにありません`);
  if (output.tax_code === null) problems.push("税区分が空です");
  else if (!has("tax", output.tax_code)) problems.push(`税区分 ${output.tax_code} はマスタにありません`);
  if (output.partner_id !== null && !has("partner", output.partner_id)) problems.push(`取引先 ${output.partner_id} はマスタにありません`);
  if (output.item_id !== null && !has("item", output.item_id)) problems.push(`品目 ${output.item_id} はマスタにありません`);
  if (output.section_id !== null && !has("section", output.section_id)) problems.push(`部門 ${output.section_id} はマスタにありません`);
  for (const id of output.tag_ids) if (!has("tag", id)) problems.push(`メモタグ ${id} はマスタにありません`);
  if (problems.length > 0 || output.account_item_id === null || output.tax_code === null) {
    return { ok: false, reason: "not_in_master", problems };
  }
  return {
    ok: true,
    entry: {
      accountItemId: output.account_item_id,
      taxCode: output.tax_code,
      partnerId: output.partner_id,
      itemId: output.item_id,
      sectionId: output.section_id,
      tagIds: [...new Set(output.tag_ids)].sort((a, b) => a - b),
      description: output.description,
    },
  };
}
