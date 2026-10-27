import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { MasterEntry, MasterKind } from "../proposals/types";
import { fetchAll } from "../supabase/fetch-all";
import { RULE_STATUSES, UUID, type RuleStatus } from "./editor-schema";

/** 読込の失敗を利用者に見せる固定文。SDK・検証エラーの中身は含めない */
export const RULE_LOAD_FAILED_MESSAGE =
  "ルールを読み込めなかったため、表示できません（「ルールなし」ではありません）。時間をおいて再読み込みしてください。";

export class RuleEditorLoadError extends Error {
  constructor() {
    super(RULE_LOAD_FAILED_MESSAGE);
    this.name = "RuleEditorLoadError";
  }
}

/** bigint は数値でも文字列でも返り得る。null や空文字を 0 にしないよう coerce は使わない */
const bigint = z.union([z.number(), z.string().regex(/^-?\d+$/)]).transform(Number).pipe(z.number().int().safe());
const int32 = z.number().int().min(-2_147_483_648).max(2_147_483_647);
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** 版の行から読む列（保存時の戻り値の確認にも使う） */
export const RULE_VERSION_COLUMNS =
  "rule_id, version, customer_id, priority, status, source, cond_partner_key, cond_description_keyword, cond_amount_min, cond_amount_max, cond_wallet_id, cond_direction, account_item_id, tax_code, partner_id, item_id, section_id, tag_ids, description_template, valid_from, valid_to, created_by, created_at";

export const ruleVersionRowSchema = z.object({
  rule_id: z.string().regex(UUID),
  version: int32.min(1),
  customer_id: z.string().regex(UUID),
  priority: int32,
  status: z.enum(RULE_STATUSES),
  source: z.enum(["staff", "correction_history", "past_entries"]),
  cond_partner_key: z.string().nullable(),
  cond_description_keyword: z.string().nullable(),
  cond_amount_min: bigint.nullable(),
  cond_amount_max: bigint.nullable(),
  cond_wallet_id: z.string().regex(UUID).nullable(),
  cond_direction: z.enum(["income", "expense"]).nullable(),
  account_item_id: bigint,
  tax_code: int32,
  partner_id: bigint.nullable(),
  item_id: bigint.nullable(),
  section_id: bigint.nullable(),
  tag_ids: z.array(bigint),
  description_template: z.string().nullable(),
  valid_from: dateText.nullable(),
  valid_to: dateText.nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
});
export type RuleVersionRow = z.output<typeof ruleVersionRowSchema>;

export type RuleSource = RuleVersionRow["source"];

/** 画面に出す、ルールの現在の版（保存されている値そのまま。補完や既定値は入れない） */
export type EditorRule = {
  ruleId: string;
  version: number;
  status: RuleStatus;
  source: RuleSource;
  priority: number;
  cond: {
    partnerKey: string | null;
    descriptionKeyword: string | null;
    amountMin: number | null;
    amountMax: number | null;
    walletId: string | null;
    direction: "income" | "expense" | null;
  };
  action: {
    accountItemId: number;
    taxCode: number;
    partnerId: number | null;
    itemId: number | null;
    sectionId: number | null;
    tagIds: number[];
    descriptionTemplate: string | null;
  };
  validFrom: string | null;
  validTo: string | null;
  createdAt: string;
};

export function toEditorRule(row: RuleVersionRow): EditorRule {
  return {
    ruleId: row.rule_id,
    version: row.version,
    status: row.status,
    source: row.source,
    priority: row.priority,
    cond: {
      partnerKey: row.cond_partner_key,
      descriptionKeyword: row.cond_description_keyword,
      amountMin: row.cond_amount_min,
      amountMax: row.cond_amount_max,
      walletId: row.cond_wallet_id,
      direction: row.cond_direction,
    },
    action: {
      accountItemId: row.account_item_id,
      taxCode: row.tax_code,
      partnerId: row.partner_id,
      itemId: row.item_id,
      sectionId: row.section_id,
      tagIds: row.tag_ids,
      descriptionTemplate: row.description_template,
    },
    validFrom: row.valid_from,
    validTo: row.valid_to,
    createdAt: row.created_at,
  };
}

export type MasterOption = { id: number; name: string };
export type WalletOption = { id: string; name: string; kind: string };

export type RuleEditorData = {
  customer: { id: string; name: string };
  /** 各ルールの現在の版（優先順位 → 作成日時 → ID の順） */
  rules: EditorRule[];
  /** 有効（available）なマスタだけ */
  masters: Record<MasterKind, MasterOption[]>;
  wallets: WalletOption[];
};

const customerSchema = z.object({ id: z.string(), name: z.string() }).nullable();
const masterRowSchema = z.object({
  customer_id: z.string(),
  kind: z.enum(["account_item", "partner", "item", "section", "tag", "tax"]),
  freee_id: bigint,
  name: z.string(),
  available: z.literal(true),
});
const walletRowSchema = z.object({ id: z.string().regex(UUID), customer_id: z.string(), name: z.string(), kind: z.string() });
const parentRowSchema = z.object({ id: z.string().regex(UUID), customer_id: z.string() });

/**
 * ログインした担当者の権限（RLS）で顧客を読む。見えない（権限外・存在しない）ときは null。
 * 読込の失敗・形式の不正・要求と違う行は例外（呼び出し側が失敗として扱う）。
 */
export async function readVisibleCustomer(client: SupabaseClient, customerId: string): Promise<{ id: string; name: string } | null> {
  const res = await client.from("customers").select("id, name").eq("id", customerId).maybeSingle();
  if (res.error) throw new Error("customers read failed");
  const customer = customerSchema.parse(res.data); // undefined は不正。見えない顧客は明示的な null だけ
  if (!customer) return null;
  if (customer.id !== customerId) throw new Error("customer mismatch");
  return customer;
}

/** 顧客の有効なマスタをすべてのページから読む。他の顧客の行が混ざっていたら例外 */
export async function readAvailableMasters(client: SupabaseClient, customerId: string): Promise<MasterEntry[]> {
  const rows = await fetchAll("マスタ", (from, to) =>
    client
      .from("freee_masters")
      .select("customer_id, kind, freee_id, name, available")
      .eq("customer_id", customerId)
      .eq("available", true)
      .order("kind")
      .order("freee_id")
      .range(from, to),
  );
  const masters = z.array(masterRowSchema).parse(rows);
  if (masters.some((m) => m.customer_id !== customerId)) throw new Error("master tenant mismatch");
  return masters.map((m) => ({ kind: m.kind, id: m.freee_id, name: m.name }));
}

/** 顧客の口座をすべてのページから読む。他の顧客の行が混ざっていたら例外 */
export async function readWallets(client: SupabaseClient, customerId: string): Promise<WalletOption[]> {
  const rows = await fetchAll("口座", (from, to) =>
    client.from("wallets").select("id, customer_id, name, kind").eq("customer_id", customerId).order("name").order("id").range(from, to),
  );
  const wallets = z.array(walletRowSchema).parse(rows);
  if (wallets.some((w) => w.customer_id !== customerId)) throw new Error("wallet tenant mismatch");
  return wallets.map((w) => ({ id: w.id, name: w.name, kind: w.kind }));
}

/**
 * 既存ルールの編集画面のデータ（読取専用）。顧客が見えないときは null。
 * 失敗はすべて RuleEditorLoadError（固定文）にして投げ、空の一覧と区別する。
 */
export async function loadRuleEditor(client: SupabaseClient, customerId: string): Promise<RuleEditorData | null> {
  if (!UUID.test(customerId)) return null;
  try {
    const customer = await readVisibleCustomer(client, customerId);
    if (!customer) return null;

    const parentRows = await fetchAll("ルール", (from, to) =>
      client.from("journal_rules").select("id, customer_id").eq("customer_id", customerId).order("id").range(from, to),
    );
    const parents = z.array(parentRowSchema).parse(parentRows);
    if (parents.some((p) => p.customer_id !== customerId)) throw new Error("rule tenant mismatch");
    const parentIds = new Set(parents.map((p) => p.id));

    // 現在の版 = ルールごとに version が最大の行（current_journal_rules は security_invoker で RLS が効く）
    const versionRows = await fetchAll("ルールの現在の版", (from, to) =>
      client.from("current_journal_rules").select(RULE_VERSION_COLUMNS).eq("customer_id", customerId).order("rule_id").range(from, to),
    );
    const versions = z.array(ruleVersionRowSchema).parse(versionRows);
    const seen = new Set<string>();
    for (const v of versions) {
      if (v.customer_id !== customerId) throw new Error("version tenant mismatch");
      if (!parentIds.has(v.rule_id)) throw new Error("version without visible parent");
      if (seen.has(v.rule_id)) throw new Error("duplicate current version");
      seen.add(v.rule_id);
    }

    const rules = versions
      .map(toEditorRule)
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.ruleId.localeCompare(b.ruleId));

    const masters: RuleEditorData["masters"] = { account_item: [], tax: [], partner: [], item: [], section: [], tag: [] };
    for (const m of await readAvailableMasters(client, customerId)) masters[m.kind].push({ id: m.id, name: m.name });

    return { customer: { id: customer.id, name: customer.name }, rules, masters, wallets: await readWallets(client, customerId) };
  } catch {
    // 中身（SDK・検証エラー・インフラの情報）は利用者にもログにも出さない
    throw new RuleEditorLoadError();
  }
}
