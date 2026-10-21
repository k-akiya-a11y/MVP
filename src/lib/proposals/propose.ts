import { buildJournalPrompt } from "../ai/prompt";
import type { AiCallResult, JournalAi } from "../ai/client";
import type { AiJournalOutput } from "../ai/schema";
import { findMasterProblems, validateAgainstMasters } from "../ai/validate";
import { computeConfidence, type ConfidenceInput, type ConfidenceResult } from "../confidence/compute";
import { searchPastEntries } from "../retrieval/search";
import { matchRule, renderDescriptionTemplate } from "../rules/match";
import type {
  BankTransaction,
  Customer,
  JournalEntryFields,
  MasterEntry,
  NoteVersion,
  PastEntry,
  RuleVersion,
} from "./types";

/** 1顧客分の判定材料（判定のたびに DB から読む） */
export type CustomerContext = {
  customer: Customer;
  masters: MasterEntry[];
  /** 各ルールの現在の版のうち、状態が「有効」のもの */
  activeRules: RuleVersion[];
  /** 各メモの現在の版のうち、状態が「有効」のもの */
  notes: NoteVersion[];
  pastEntries: PastEntry[];
  walletNames: Map<string, string>;
};

/** AI判断ログ1行分の中身（src/lib/audit で DB の行にする） */
export type DecisionDraft = {
  customerId: string;
  bankTransactionId: string;
  transactionSnapshot: BankTransaction & { walletName: string; partnerKey: string | null };
  proposal: JournalEntryFields | null;
  confidence: ConfidenceResult;
  ruleVersionsUsed: { ruleId: string; version: number }[];
  noteVersionsUsed: { noteId: string; version: number }[];
  pastEntryIds: string[];
  ai: {
    output: AiJournalOutput | null;
    reason: string | null;
    unknowns: string[];
    model: string | null;
    promptVersion: string | null;
    usage: AiCallResult["usage"] | null;
  };
};

/**
 * 明細1件の仕訳候補を作る（設計書1章の処理2〜4）。
 * ルールに一致すれば AI を呼ばずにルールの処理を提案し、一致しなければ AI に案を作らせる。
 * ここは提案を作るだけで、DB への記録は呼出し側、外部への書込は src/lib/execution だけが行う。
 */
export async function proposeForTransaction(
  ctx: CustomerContext,
  txn: BankTransaction,
  ai: JournalAi,
): Promise<DecisionDraft> {
  const rule = matchRule(txn, ctx.activeRules);
  const past = searchPastEntries(txn, ctx.pastEntries);
  const walletName = ctx.walletNames.get(txn.walletId) ?? "";
  const knownCombos = new Set(ctx.pastEntries.map((p) => `${p.entry.accountItemId}:${p.entry.taxCode}`));

  let proposal: JournalEntryFields | null = null;
  let ruleProblems: string[] = [];
  let aiState: ConfidenceInput["ai"] = { called: false };
  let aiLog: DecisionDraft["ai"] = {
    output: null,
    reason: null,
    unknowns: [],
    model: null,
    promptVersion: null,
    usage: null,
  };

  if (rule) {
    const { descriptionTemplate, ...entry } = rule.action;
    // ルールもマスタと照らす。マスタにない値（削除された部門など）を含むルールは提案に使わず、
    // 確信度「低」で人の確認に回す（承認時にも DB で弾くが、候補の段階で止める）
    ruleProblems = findMasterProblems(entry, ctx.masters);
    if (ruleProblems.length === 0) {
      proposal = {
        ...entry,
        description: descriptionTemplate ? renderDescriptionTemplate(descriptionTemplate, txn) : txn.description,
      };
    }
  } else {
    const result = await ai(
      buildJournalPrompt({ customer: ctx.customer, masters: ctx.masters, notes: ctx.notes, txn, walletName, past }),
    );
    aiLog = {
      output: result.status === "ok" ? result.output : null,
      reason: result.status === "ok" ? result.output.reason : null,
      unknowns: result.status === "ok" ? result.output.unknowns : [`AI の回答を使えません（${result.status}: ${result.detail}）`],
      model: result.model,
      promptVersion: result.promptVersion,
      usage: result.usage,
    };
    if (result.status === "ok") {
      const validated = validateAgainstMasters(result.output, ctx.masters);
      if (validated.ok) proposal = validated.entry;
      else aiLog.unknowns = [...aiLog.unknowns, ...validated.problems];
      aiState = {
        called: true,
        status: validated.ok ? "ok" : validated.reason,
        fixedAssetPossible: result.output.fixed_asset_possible,
        officerOrPersonal: result.output.officer_or_personal,
      };
    } else {
      aiState = { called: true, status: result.status, fixedAssetPossible: false, officerOrPersonal: false };
    }
  }

  const confidence = computeConfidence({
    txn,
    customer: ctx.customer,
    masters: ctx.masters,
    rule,
    ruleProblems,
    past,
    knownCombos,
    proposal,
    ai: aiState,
  });

  return {
    customerId: txn.customerId,
    bankTransactionId: txn.id,
    transactionSnapshot: { ...txn, walletName, partnerKey: past.partnerKey },
    proposal,
    confidence,
    ruleVersionsUsed: rule ? [{ ruleId: rule.ruleId, version: rule.version }] : [],
    noteVersionsUsed: aiState.called ? ctx.notes.map((n) => ({ noteId: n.noteId, version: n.version })) : [],
    pastEntryIds: past.examples.map((e) => e.id),
    ai: aiLog,
  };
}
