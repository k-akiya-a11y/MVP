import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { MasterKind } from "../proposals/types";

const int = z.coerce.number().int();

const entrySchema = z.object({
  account_item_id: int,
  tax_code: int,
  partner_id: int.nullable(),
  item_id: int.nullable(),
  section_id: int.nullable(),
  tag_ids: z.array(int),
  description: z.string(),
});
export type EntryJson = z.infer<typeof entrySchema>;

const breakdownSchema = z
  .object({
    rule: z.object({ matched: z.boolean(), ruleId: z.string().nullable(), version: z.number().nullable() }),
    past: z.object({
      matchType: z.string(),
      total: z.number(),
      majority: z.object({ share: z.number() }).passthrough().nullable(),
    }).passthrough(),
    checks: z.array(z.object({ id: z.string(), passed: z.boolean(), detail: z.string() })),
    forcedLow: z.array(z.string()),
    reasons: z.array(z.string()),
  })
  .passthrough();

export type ReviewItem = {
  decisionId: string;
  decidedAt: string;
  txn: {
    id: string;
    date: string;
    amount: number;
    direction: "income" | "expense";
    description: string;
    walletName: string;
    status: "proposed" | "on_hold";
  };
  confidence: "high" | "medium" | "low";
  proposal: EntryJson | null;
  reasons: string[];
  forcedLow: string[];
  checks: { id: string; passed: boolean; detail: string }[];
  rule: { ruleId: string; version: number } | null;
  past: { matchType: string; total: number; majorityShare: number | null };
  aiReason: string | null;
  unknowns: string[];
  aiUsed: boolean;
  pastExamples: { id: string; date: string; amount: number; bankDescription: string | null; entry: EntryJson }[];
};

export type MasterOption = { id: number; name: string };
export type ReviewQueue = {
  customer: { id: string; name: string };
  items: ReviewItem[];
  masters: Record<MasterKind, MasterOption[]>;
  wallets: { id: string; name: string; kind: string }[];
};

function ok<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}の読込に失敗しました: ${res.error.message}`);
  return res.data as T;
}

/**
 * 承認画面のデータ。ログインした担当者の権限（RLS）で読むので、担当外の顧客は空になる。
 * 対象は「候補作成済」と「保留」の明細で、各明細の最新の AI 判断を使う。
 */
export async function loadReviewQueue(client: SupabaseClient, customerId: string): Promise<ReviewQueue | null> {
  const customer = z
    .object({ id: z.string(), name: z.string() })
    .nullable()
    .parse(ok(await client.from("customers").select("id, name").eq("id", customerId).maybeSingle(), "顧客"));
  if (!customer) return null;

  const [txnsRes, mastersRes, walletsRes] = await Promise.all([
    client
      .from("bank_transactions")
      .select("id, wallet_id, txn_date, amount, direction, description, status")
      .eq("customer_id", customerId)
      .in("status", ["proposed", "on_hold"])
      .order("txn_date")
      .limit(500),
    client.from("freee_masters").select("kind, freee_id, name").eq("customer_id", customerId).eq("available", true).order("freee_id"),
    client.from("wallets").select("id, name, kind").eq("customer_id", customerId).order("name"),
  ]);
  const txns = z
    .array(
      z.object({
        id: z.string(),
        wallet_id: z.string(),
        txn_date: z.string(),
        amount: int,
        direction: z.enum(["income", "expense"]),
        description: z.string(),
        status: z.enum(["proposed", "on_hold"]),
      }),
    )
    .parse(ok(txnsRes, "明細"));
  const wallets = z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() })).parse(ok(walletsRes, "口座"));
  const walletNames = new Map(wallets.map((w) => [w.id, w.name]));

  const masters: ReviewQueue["masters"] = { account_item: [], tax: [], partner: [], item: [], section: [], tag: [] };
  for (const m of z
    .array(z.object({ kind: z.enum(["account_item", "partner", "item", "section", "tag", "tax"]), freee_id: int, name: z.string() }))
    .parse(ok(mastersRes, "マスタ"))) {
    masters[m.kind].push({ id: m.freee_id, name: m.name });
  }

  const decisions =
    txns.length === 0
      ? []
      : z
          .array(
            z.object({
              id: z.string(),
              bank_transaction_id: z.string(),
              created_at: z.string(),
              confidence: z.enum(["high", "medium", "low"]),
              proposal: entrySchema.nullable(),
              confidence_breakdown: breakdownSchema,
              past_entry_ids: z.array(z.string()),
              ai_reason: z.string().nullable(),
              ai_unknowns: z.array(z.string()),
              model: z.string().nullable(),
            }),
          )
          .parse(
            ok(
              await client
                .from("latest_ai_decisions")
                .select("id, bank_transaction_id, created_at, confidence, proposal, confidence_breakdown, past_entry_ids, ai_reason, ai_unknowns, model")
                .in("bank_transaction_id", txns.map((t) => t.id)),
              "仕訳候補",
            ),
          );
  const decisionByTxn = new Map(decisions.map((d) => [d.bank_transaction_id, d]));

  const pastIds = [...new Set(decisions.flatMap((d) => d.past_entry_ids))];
  const pastRows =
    pastIds.length === 0
      ? []
      : z
          .array(
            z.object({
              id: z.string(),
              entry_date: z.string(),
              amount: int,
              bank_description: z.string().nullable(),
              ...entrySchema.shape,
              description: z.string().nullable(),
            }),
          )
          .parse(
            ok(
              await client
                .from("past_journal_entries")
                .select("id, entry_date, amount, bank_description, account_item_id, tax_code, partner_id, item_id, section_id, tag_ids, description")
                .in("id", pastIds),
              "過去仕訳",
            ),
          );
  const pastById = new Map(pastRows.map((p) => [p.id, p]));

  const items: ReviewItem[] = [];
  for (const t of txns) {
    const d = decisionByTxn.get(t.id);
    if (!d) continue;
    const b = d.confidence_breakdown;
    items.push({
      decisionId: d.id,
      decidedAt: d.created_at,
      txn: {
        id: t.id,
        date: t.txn_date,
        amount: t.amount,
        direction: t.direction,
        description: t.description,
        walletName: walletNames.get(t.wallet_id) ?? "",
        status: t.status,
      },
      confidence: d.confidence,
      proposal: d.proposal,
      reasons: b.reasons,
      forcedLow: b.forcedLow,
      checks: b.checks,
      rule: b.rule.matched && b.rule.ruleId && b.rule.version !== null ? { ruleId: b.rule.ruleId, version: b.rule.version } : null,
      past: { matchType: b.past.matchType, total: b.past.total, majorityShare: b.past.majority?.share ?? null },
      aiReason: d.ai_reason,
      unknowns: d.ai_unknowns,
      aiUsed: d.model !== null,
      pastExamples: d.past_entry_ids.flatMap((id) => {
        const p = pastById.get(id);
        return p
          ? [
              {
                id: p.id,
                date: p.entry_date,
                amount: p.amount,
                bankDescription: p.bank_description,
                entry: {
                  account_item_id: p.account_item_id,
                  tax_code: p.tax_code,
                  partner_id: p.partner_id,
                  item_id: p.item_id,
                  section_id: p.section_id,
                  tag_ids: p.tag_ids,
                  description: p.description ?? "",
                },
              },
            ]
          : [];
      }),
    });
  }

  return { customer: { id: customer.id, name: customer.name }, items, masters, wallets };
}
