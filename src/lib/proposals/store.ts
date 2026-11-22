import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { AiDecisionRow } from "../audit/decision-log";
import { fetchAll } from "../supabase/fetch-all";
import type { CustomerContext } from "./propose";
import type { BankTransaction, MasterEntry, PastEntry, RuleVersion } from "./types";

/**
 * 明細の作業の貸出し（リース）の期間（秒）。Vercel の関数の最大実行時間（cron ルートの maxDuration = 300 秒）より長くする。
 * 生きている実行は最大実行時間を超えて続かないので、期限が切れた貸出しの持ち主はもう動いていない。
 */
export const CLAIM_LEASE_SECONDS = 600;

/** 仕訳候補の作成で使う DB 操作。テストではモックに差し替える */
export type ProposalStore = {
  /**
   * 未判定（new）の明細を、DB に持つ走査位置から (txn_date, id) の昇順で最大 limit 件受け取り、位置を進める。
   * 受け取った明細は、このストア（1 回の実行）の所有者として貸し出され、期限内は他の実行に渡らない。
   * 位置の読取・選択・貸出し・更新は DB の 1 トランザクション（claim_pending_proposal_batch）で行うので、
   * 並行する実行とは重ならず、位置は後戻りしない。末尾に届くと位置は先頭に戻り、失敗して new のまま残った明細を再び調べる。
   * 位置はこの関数の外（メモリなど）に持たない。
   * ジョブ（runProposalJob）は limit = 1 で判定の直前に呼ぶ。位置は借りた明細の分だけ進むので、判定を始めなかった明細を飛ばさない。
   */
  claimPendingBatch(limit: number): Promise<BankTransaction[]>;
  /** AI を呼ぶ直前に、明細がまだ自分の貸出しか確かめて期限を延ばす。奪われていれば false（その明細に AI を呼ばない） */
  confirmClaim(bankTransactionId: string): Promise<boolean>;
  /** 失敗・中止・未着手の明細の貸出しを返す（自分の貸出しだけ）。明細は new のまま残り、次の巡回で再び調べられる */
  releaseClaims(bankTransactionIds: string[]): Promise<void>;
  loadCustomerContext(customerId: string, onDate: string): Promise<CustomerContext>;
  /** 貸出しの所有者として判断を記録し、貸出しを終える。所有者でなければ（期限切れで奪われた後など）拒否される */
  recordDecision(row: AiDecisionRow): Promise<string>;
};

const direction = z.enum(["income", "expense"]);
// bigint 列は supabase-js では number で返る（freee の ID・金額は Number.MAX_SAFE_INTEGER に収まる）。
// 数値は安全な整数だけ、文字列は 10 進の整数（符号は "-" のみ、空白・指数・16進・小数は不可）だけを通す。
// z.coerce は null・空文字・真偽値・配列を 0 / 1 に変換してしまうため使わない。"-0" は 0 にする。
const int = z
  .union([z.number(), z.string().regex(/^-?[0-9]+$/)])
  .transform(Number)
  .pipe(z.number().refine((n) => Number.isSafeInteger(n)))
  .transform((n) => (n === 0 ? 0 : n));
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
  attrs: z.record(z.string(), z.unknown()).superRefine((attrs, ctx) => {
    // fixed_asset は固定資産の強制「低」の根拠。存在するのに真偽値でない値を false として読むと、そのガードが静かに外れる
    if (Object.hasOwn(attrs, "fixed_asset") && typeof attrs.fixed_asset !== "boolean") {
      ctx.addIssue({ code: "custom", path: ["fixed_asset"], message: "fixed_asset は true か false のどちらかで指定してください" });
    }
  }),
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
 * owner は 1 回の実行ごとに新しく作る（貸出しの所有者。実行をまたいで使い回さない）。
 */
export function supabaseProposalStore(client: SupabaseClient, owner: string = randomUUID()): ProposalStore {
  return {
    async claimPendingBatch(limit) {
      // service_role 専用の RPC。位置の更新と貸出しまで DB 側で行うため、ここでは位置を持たない
      const data = check(
        await client.rpc("claim_pending_proposal_batch", { p_limit: limit, p_owner: owner, p_lease_seconds: CLAIM_LEASE_SECONDS }),
        "未判定の明細",
      );
      const parsed = z.array(txnRow).safeParse(data);
      if (!parsed.success) {
        // 呼出し側（run.ts）はまだ 1 行も受け取っていないので、貸出し済みの行は返却されない。ここで返してから元の検証エラーを投げる
        await releaseUnparsedClaims(client, owner, data);
        throw parsed.error;
      }
      return parsed.data.map((r) => ({
          id: r.id,
          customerId: r.customer_id,
          walletId: r.wallet_id,
          txnDate: r.txn_date,
          amount: r.amount,
          direction: r.direction,
          description: r.description,
        }));
    },

    async confirmClaim(bankTransactionId) {
      const { data, error } = await client.rpc("renew_proposal_claim", {
        p_owner: owner,
        p_bank_transaction_id: bankTransactionId,
        p_lease_seconds: CLAIM_LEASE_SECONDS,
      });
      if (error) throw new Error(`貸出しの確認に失敗しました: ${error.message}`);
      return z.boolean().parse(data);
    },

    async releaseClaims(bankTransactionIds) {
      if (bankTransactionIds.length === 0) return;
      const { error } = await client.rpc("release_proposal_claims", { p_owner: owner, p_ids: bankTransactionIds });
      if (error) throw new Error(`貸出しの返却に失敗しました: ${error.message}`);
    },

    async loadCustomerContext(customerId, onDate) {
      const [customer, masters, rules, notes, past, wallets] = await Promise.all([
        client.from("customers").select("id, name, tax_method, invoice_registered, low_confidence_amount_threshold").eq("id", customerId).single(),
        fetchAll("マスタ", (from, to) =>
          client
            .from("freee_masters")
            .select("kind, freee_id, name, attrs")
            .eq("customer_id", customerId)
            .eq("available", true)
            .order("kind")
            .order("freee_id")
            .range(from, to),
        ),
        fetchAll("ルール", (from, to) =>
          client.from("current_journal_rules").select("*").eq("customer_id", customerId).order("rule_id").range(from, to),
        ),
        fetchAll("メモ", (from, to) =>
          client
            .from("current_customer_notes")
            .select("note_id, version, status, title, body")
            .eq("customer_id", customerId)
            .order("note_id")
            .range(from, to),
        ),
        // 過去一致率を一部のデータで計算しないよう、24か月分を全件読む
        fetchAll("過去仕訳", (from, to) =>
          client
            .from("past_journal_entries")
            .select("id, entry_date, amount, direction, bank_description, partner_key, account_item_id, tax_code, partner_id, item_id, section_id, tag_ids, description")
            .eq("customer_id", customerId)
            .gte("entry_date", shiftYears(onDate, -2))
            // 基準日（ジョブの実行日）より後の仕訳は、まだ存在しない前提の情報なので使わない
            .lte("entry_date", onDate)
            .order("id")
            .range(from, to),
        ),
        fetchAll("口座", (from, to) => client.from("wallets").select("id, name").eq("customer_id", customerId).order("id").range(from, to)),
      ]);

      const c = customerRow.parse(check(customer, "顧客"));
      const masterEntries: MasterEntry[] = z
        .array(masterRow)
        .parse(masters)
        .map((m) => ({
          kind: m.kind,
          id: m.freee_id,
          name: m.name,
          defaultTaxCode: typeof m.attrs.default_tax_code === "number" ? m.attrs.default_tax_code : undefined,
          fixedAsset: m.attrs.fixed_asset === true,
        }));
      const activeRules: RuleVersion[] = z
        .array(ruleRow)
        .parse(rules)
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
        .parse(notes)
        .filter((n) => n.status === "active")
        .map((n) => ({ noteId: n.note_id, version: n.version, title: n.title, body: n.body }));
      const pastEntries: PastEntry[] = z
        .array(pastRow)
        .parse(past)
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
          .parse(wallets)
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
      // 貸出しの所有者だけが記録できる（record_ai_decision の「new にだけ記録」も DB 側で維持される）
      const { data, error } = await client.rpc("record_claimed_ai_decision", { p_owner: owner, p_decision: row });
      if (error) throw new Error(`AI判断の記録に失敗しました: ${error.message}`);
      return z.string().uuid().parse(data);
    },
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 貸出しの RPC が成功したのに返り値の検証に失敗したとき、返り値の生の配列から ID を特定できる行の貸出しを、このストア自身の owner で返す。
 * 返り値の中の owner は使わない。ID が特定できなければ（配列でない・UUID でない）何もせず、期限（CLAIM_LEASE_SECONDS）に任せる。
 * 最善努力: 返却の失敗は握りつぶし、呼出し側は元の検証エラーを投げる。
 */
async function releaseUnparsedClaims(client: SupabaseClient, owner: string, raw: unknown): Promise<void> {
  if (!Array.isArray(raw)) return;
  const ids = new Set<string>();
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && UUID_PATTERN.test(id)) ids.add(id);
  }
  if (ids.size === 0) return;
  try {
    await client.rpc("release_proposal_claims", { p_owner: owner, p_ids: [...ids] });
  } catch {
    // 元の検証エラーを隠さない
  }
}

/** 過去仕訳は直近24か月分を使う（設計書3章） */
export function shiftYears(date: string, years: number): string {
  const [y, m, d] = date.split("-");
  const month = Number(m);
  const year = Number(y) + years;
  // 暦の年単位でずらす。移動先に同じ日がない（うるう日 → 平年）ときは、その月の末日に丸める
  const day = Math.min(Number(d), daysInMonth(year, month));
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
