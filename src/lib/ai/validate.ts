import type { JournalEntryFields, MasterEntry, MasterKind } from "../proposals/types";
import type { AiJournalOutput } from "./schema";

export type ValidatedAiOutput =
  | { ok: true; entry: JournalEntryFields }
  | { ok: false; reason: "cannot_decide" | "not_in_master"; problems: string[] };

/**
 * 仕訳の各 ID がマスタの写しにあるかを調べ、問題を文章で返す（空なら問題なし）。
 * AI の回答にも、顧客ルールの処理にも使う（CLAUDE.md 4章: マスタにある値だけ受け付ける）。
 */
export function findMasterProblems(
  entry: {
    accountItemId: number | null;
    taxCode: number | null;
    partnerId: number | null;
    itemId: number | null;
    sectionId: number | null;
    tagIds: readonly number[];
  },
  masters: readonly MasterEntry[],
): string[] {
  const has = (kind: MasterKind, id: number) => masters.some((m) => m.kind === kind && m.id === id);
  const problems: string[] = [];
  if (entry.accountItemId === null) problems.push("勘定科目が空です");
  else if (!has("account_item", entry.accountItemId)) problems.push(`勘定科目 ${entry.accountItemId} はマスタにありません`);
  if (entry.taxCode === null) problems.push("税区分が空です");
  else if (!has("tax", entry.taxCode)) problems.push(`税区分 ${entry.taxCode} はマスタにありません`);
  if (entry.partnerId !== null && !has("partner", entry.partnerId)) problems.push(`取引先 ${entry.partnerId} はマスタにありません`);
  if (entry.itemId !== null && !has("item", entry.itemId)) problems.push(`品目 ${entry.itemId} はマスタにありません`);
  if (entry.sectionId !== null && !has("section", entry.sectionId)) problems.push(`部門 ${entry.sectionId} はマスタにありません`);
  for (const id of entry.tagIds) if (!has("tag", id)) problems.push(`メモタグ ${id} はマスタにありません`);
  return problems;
}

/**
 * AI の回答をマスタの写しと照らす。1つでもマスタにない ID があれば提案全体を弾く。
 */
export function validateAgainstMasters(output: AiJournalOutput, masters: readonly MasterEntry[]): ValidatedAiOutput {
  if (output.decision === "cannot_decide") {
    return { ok: false, reason: "cannot_decide", problems: [] };
  }
  const problems = findMasterProblems(
    {
      accountItemId: output.account_item_id,
      taxCode: output.tax_code,
      partnerId: output.partner_id,
      itemId: output.item_id,
      sectionId: output.section_id,
      tagIds: output.tag_ids,
    },
    masters,
  );
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
