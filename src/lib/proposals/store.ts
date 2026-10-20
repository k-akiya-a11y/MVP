import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { AiDecisionRow } from "../audit/decision-log";
import type { CustomerContext } from "./propose";
import type { BankTransaction, MasterEntry, PastEntry, RuleVersion } from "./types";

/** 仕訳候補の作成で使う DB 操作。テストではモックに差し替える */
export type ProposalStore = {
  listPendingTransactions(limit: number): Promise<BankTransaction[]>;
  loadCustomerContext(customerId: string, onDate: string): Promise<CustomerContext>;
  recordDecision(row: AiDecisionRow): Promise<string>;
};

const direction = z.enum(["income", "expense"]);
// bigint 列は supabase-js では number で返る（freee の ID・金額は Number.MAX_SAFE_INTEGER に収まる）
const int = z.coerce.number().int();
const nullableInt = int.nullable();

const txnRow = z.object({
  id: z.string(),
  customer_id: z.string(),
  wallet_id: z.string(),
  txn_date: z.string(),
  amount: int,
  direction,
  description: z.string(),
});

const entryColumns = {
  account_item_id: int,
  tax_code: int,
  partner_id: nullableInt,
  item_id: nullableInt,
  section_id: nullableInt,
  tag_ids: z.array(int),
};

const ruleRow = z.object({
  rule_id: z.string(),
  version: int,
  priority: int,
  status: z.enum(["active", "proposed", "inactive"]),
  created_at: z.string(),
  cond_partner_key: z.string().nullable(),
  cond_description_keyword: z.string().nullable(),
  cond_amount_min: nullableInt,
  cond_amount_max: nullableInt,
  cond_wallet_id: z.string().nullable(),
  cond_direction: direction.nullable(),
  ...entryColumns,
  description_template: z.string().nullable(),
  valid_from: z.string().nullable(),
  valid_to: z.string().nullable(),
});

const pastRow = z.object({
  id: z.string(),
  entry_date: z.string(),
  amount: int,
  direction,
  bank_description: z.string().nullable(),
  partner_key: z.string().nullable(),
  ...entryColumns,
  description: z.string().nullable(),
});

const masterRow = z.object({
  kind: z.enum(["account_item", "partner", "item", "section", "tag", "tax"]),
  freee_id: int,
  name: z.string(),
  attrs: z.record(z.string(), z.unknown()),
});

const customerRow = z.object({
  id: z.string(),
  name: z.string(),
  tax_method: z.enum(["general", "simplified", "exempt"]),
  invoice_registered: z.boolean(),
  low_confidence_amount_threshold: int,
});

function check<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}の読込に失敗しました: ${result.error.message}`);
  if (result.data === null) throw new Error(`${what}がありません`);
  return result.data;
}

/**
 * service_role で接続した Supabase を使う実装。RLS を通らないので、読むときは必ず customer_id で絞る。
 */
export function supabaseProposalStore(client: SupabaseClient): ProposalStore {
  return {
    async listPendingTransactions(limit) {
      const data = check(
        await client
          .from("bank_transactions")
          .select("id, customer_id, wallet_id, txn_date, amount, direction, description")
          .eq("status", "new")
          .order("txn_date")
          .limit(limit),
        "未判定の明細",
      );
      return z
        .array(txnRow)
        .parse(data)
        .map((r) => ({
          id: r.id,
          customerId: r.customer_id,
          walletId: r.wallet_id,
          txnDate: r.txn_date,
          amount: r.amount,
          direction: r.direction,
          description: r.description,
        }));
    },

    async loadCustomerContext(customerId, onDate) {
      const [customer, masters, rules, notes, past, wallets] = await Promise.all([
        client.from("customers").select("id, name, tax_method, invoice_registered, low_confidence_amount_threshold").eq("id", customerId).single(),
        client.from("freee_masters").select("kind, freee_id, name, attrs").eq("customer_id", customerId).eq("available", true),
        client.from("current_journal_rules").select("*").eq("customer_id", customerId),
        client.from("current_customer_notes").select("note_id, version, status, title, body").eq("customer_id", customerId),
        client
          .from("past_journal_entries")
          .select("id, entry_date, amount, direction, bank_description, partner_key, account_item_id, tax_code, partner_id, item_id, section_id, tag_ids, description")
          .eq("customer_id", customerId)
          .gte("entry_date", shiftYears(onDate, -2)),
        client.from("wallets").select("id, name").eq("customer_id", customerId),
      ]);

      const c = customerRow.parse(check(customer, "顧客"));
      const masterEntries: MasterEntry[] = z
        .array(masterRow)
        .parse(check(masters, "マスタ"))
        .map((m) => ({
          kind: m.kind,
          id: m.freee_id,
          name: m.name,
          defaultTaxCode: typeof m.attrs.default_tax_code === "number" ? m.attrs.default_tax_code : undefined,
          fixedAsset: m.attrs.fixed_asset === true,
        }));
      const activeRules: RuleVersion[] = z
        .array(ruleRow)
        .parse(check(rules, "ルール"))
        .filter((r) => r.status === "active")
        .map((r) => ({
          ruleId: r.rule_id,
          version: r.version,
          priority: r.priority,
          createdAt: r.created_at,
          cond: {
            partnerKey: r.cond_partner_key,
            descriptionKeyword: r.cond_description_keyword,
            amountMin: r.cond_amount_min,
            amountMax: r.cond_amount_max,
            walletId: r.cond_wallet_id,
            direction: r.cond_direction,
          },
          action: {
            accountItemId: r.account_item_id,
            taxCode: r.tax_code,
            partnerId: r.partner_id,
            itemId: r.item_id,
            sectionId: r.section_id,
            tagIds: r.tag_ids,
            description: "",
            descriptionTemplate: r.description_template,
          },
          validFrom: r.valid_from,
          validTo: r.valid_to,
        }));
      const activeNotes = z
        .array(z.object({ note_id: z.string(), version: int, status: z.string(), title: z.string(), body: z.string() }))
        .parse(check(notes, "メモ"))
        .filter((n) => n.status === "active")
        .map((n) => ({ noteId: n.note_id, version: n.version, title: n.title, body: n.body }));
      const pastEntries: PastEntry[] = z
        .array(pastRow)
        .parse(check(past, "過去仕訳"))
        .map((p) => ({
          id: p.id,
          entryDate: p.entry_date,
          amount: p.amount,
          direction: p.direction,
          bankDescription: p.bank_description,
          partnerKey: p.partner_key,
          entry: {
            accountItemId: p.account_item_id,
            taxCode: p.tax_code,
            partnerId: p.partner_id,
            itemId: p.item_id,
            sectionId: p.section_id,
            tagIds: p.tag_ids,
            description: p.description ?? "",
          },
        }));
      const walletNames = new Map(
        z
          .array(z.object({ id: z.string(), name: z.string() }))
          .parse(check(wallets, "口座"))
          .map((w) => [w.id, w.name] as const),
      );

      return {
        customer: {
          id: c.id,
          name: c.name,
          taxMethod: c.tax_method,
          invoiceRegistered: c.invoice_registered,
          lowConfidenceAmountThreshold: c.low_confidence_amount_threshold,
        },
        masters: masterEntries,
        activeRules,
        notes: activeNotes,
        pastEntries,
        walletNames,
      };
    },

    async recordDecision(row) {
      const { data, error } = await client.rpc("record_ai_decision", { p_decision: row });
      if (error) throw new Error(`AI判断の記録に失敗しました: ${error.message}`);
      return z.string().uuid().parse(data);
    },
  };
}

/** 過去仕訳は直近24か月分を使う（設計書3章） */
function shiftYears(date: string, years: number): string {
  const [y, m, d] = date.split("-");
  return `${Number(y) + years}-${m}-${d}`;
}
