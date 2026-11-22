import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { fetchAll } from "../supabase/fetch-all";
import { aggregatePastQuality, type PastQualityReport } from "./past-quality";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** bigint は数値でも文字列でも返り得る。null や空文字を 0 にしないよう coerce は使わない */
const bigint = z.union([z.number(), z.string().regex(/^-?\d+$/)]).transform(Number).pipe(z.number().int().safe());

const customerSchema = z.object({ id: z.string(), name: z.string() }).nullable();
const entrySchema = z.object({
  id: z.string().min(1),
  customer_id: z.string(),
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  direction: z.enum(["income", "expense"]),
  partner_key: z.string().nullable(),
  account_item_id: bigint,
});
const masterSchema = z.object({
  customer_id: z.string(),
  kind: z.literal("account_item"),
  freee_id: bigint,
  name: z.string(),
  available: z.boolean(),
});

export type AccountLabel = { name: string; available: boolean };

export type PastQuality = {
  customer: { id: string; name: string };
  report: PastQualityReport;
  /** 科目ID → マスタの名前。マスタにない科目IDは含まれない（表示側でIDのまま示す） */
  accounts: Map<number, AccountLabel>;
};

/**
 * 過去仕訳の科目の揺れを読む（読取専用）。ログインした担当者の権限（RLS）で読み、
 * さらに customer_id を明示して絞る。顧客が見えない（権限外・存在しない）ときは null を返し、過去仕訳は読まない。
 * 読込の失敗・形式の不正・他の顧客の行の混入は、空の結果にせず例外にする。
 */
export async function loadPastQuality(client: SupabaseClient, customerId: string): Promise<PastQuality | null> {
  if (!UUID.test(customerId)) throw new Error("顧客IDの形式が正しくありません");

  const customerRes = await client.from("customers").select("id, name").eq("id", customerId).maybeSingle();
  if (customerRes.error) throw new Error(`顧客の読込に失敗しました: ${customerRes.error.message}`);
  const customer = customerSchema.parse(customerRes.data); // undefined は不正。見えない顧客は明示的な null だけ
  if (!customer) return null;
  if (customer.id !== customerId) throw new Error("顧客の読込結果が要求と一致しません");

  const entryRows = await fetchAll("過去仕訳", (from, to) =>
    client
      .from("past_journal_entries")
      .select("id, customer_id, entry_date, direction, partner_key, account_item_id")
      .eq("customer_id", customerId)
      .order("id")
      .range(from, to),
  );
  const entries = z.array(entrySchema).parse(entryRows);
  if (entries.some((e) => e.customer_id !== customerId)) throw new Error("他の顧客の過去仕訳が含まれていたため読込を中止しました");

  // 無効になった過去のマスタも名前を出したいので available では絞らない
  const masterRows = await fetchAll("勘定科目マスタ", (from, to) =>
    client
      .from("freee_masters")
      .select("customer_id, kind, freee_id, name, available")
      .eq("customer_id", customerId)
      .eq("kind", "account_item")
      .order("freee_id")
      .range(from, to),
  );
  const masters = z.array(masterSchema).parse(masterRows);
  if (masters.some((m) => m.customer_id !== customerId)) throw new Error("他の顧客のマスタが含まれていたため読込を中止しました");

  const accounts = new Map<number, AccountLabel>();
  for (const m of masters) {
    if (accounts.has(m.freee_id)) throw new Error(`勘定科目マスタのIDが重複しています: ${m.freee_id}`);
    accounts.set(m.freee_id, { name: m.name, available: m.available });
  }

  const report = aggregatePastQuality(
    entries.map((e) => ({
      id: e.id,
      entryDate: e.entry_date,
      direction: e.direction,
      partnerKey: e.partner_key,
      accountItemId: e.account_item_id,
    })),
  );
  return {
    customer: { id: customer.id, name: customer.name },
    report,
    accounts,
  };
}
