import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 1ページの件数。固定（利用者が変えられない） */
export const HISTORY_PAGE_SIZE = 50;
/** ページ番号の上限（URL の桁あふれ・巨大な offset を防ぐ） */
export const MAX_PAGE = 10000;

/** ?page= の値。1 以上の整数だけを受け付け、それ以外（不正・範囲外・複数指定）は 1 ページ目にする */
export function parseHistoryPage(raw: string | string[] | undefined): number {
  if (typeof raw !== "string" || !/^[1-9]\d{0,4}$/.test(raw)) return 1;
  const n = Number(raw);
  return n <= MAX_PAGE ? n : 1;
}

/** bigint は数値でも文字列でも返り得る。 */
const bigint = z.union([z.number(), z.string().regex(/^-?\d+$/)]).transform(Number).pipe(z.number().int().safe());

const reviewSchema = z.object({
  id: z.string().min(1),
  customer_id: z.string(),
  ai_decision_id: z.string().min(1),
  action: z.enum(["approve", "correct", "hold", "reject"]),
  final_entry: z.unknown(),
  diff: z.unknown(),
  reason: z.string().nullable(),
  reviewer_id: z.string(),
  bulk: z.boolean(),
  created_at: z.string(),
});
const decisionSchema = z.object({
  id: z.string(),
  customer_id: z.string(),
  bank_transaction_id: z.string(),
  proposal: z.unknown(),
});
const txnSchema = z.object({
  id: z.string(),
  customer_id: z.string(),
  txn_date: z.string(),
  amount: bigint,
  direction: z.enum(["income", "expense"]),
  description: z.string(),
});
const masterSchema = z.object({
  customer_id: z.string(),
  kind: z.enum(["account_item", "partner", "item", "section", "tag", "tax"]),
  freee_id: bigint,
  name: z.string(),
  available: z.boolean(),
});
const staffSchema = z.object({ user_id: z.string(), display_name: z.string() });

/** 仕訳候補・確定内容の1項目ずつ。形式が想定と違っても落とさず、項目単位で「記録なし」と示す */
export type EntryRecord = Record<string, unknown>;

/** 仕訳候補の状態。判断の行が読めない（unavailable）ことと、AI が提案なしだった（none）ことを区別する */
export type ProposalView = { state: "ok"; entry: EntryRecord } | { state: "none" } | { state: "unavailable" };

export type HistoryRow = {
  reviewId: string;
  action: "approve" | "correct" | "hold" | "reject";
  at: string;
  bulk: boolean;
  reviewer: { id: string; name: string | null };
  reason: string | null;
  decisionId: string;
  /** 明細が読めないときは null（表示側で「表示できません」と示す） */
  txn: { id: string; date: string; amount: number; direction: "income" | "expense"; description: string } | null;
  proposal: ProposalView;
  /** 承認・修正のときの確定内容。形式が不正なときは null */
  finalEntry: EntryRecord | null;
  diff: { field: string; before: unknown; after: unknown }[];
};

/** マスタの名前。キーは `${kind}:${freee_id}`。名前がない ID は含まれない */
export type MasterNames = Map<string, { name: string; available: boolean }>;
export const masterKey = (kind: string, id: number) => `${kind}:${id}`;

export type ReviewHistory = {
  customer: { id: string; name: string };
  page: number;
  pageSize: number;
  rows: HistoryRow[];
  hasPrevious: boolean;
  /** 次のページへのリンクを出してよいか。表示できる最終ページ（MAX_PAGE）では、より古い記録があっても false */
  hasNext: boolean;
  /** 表示できる最終ページより古い記録がある（この画面では辿れない） */
  olderBeyondLimit: boolean;
  masters: MasterNames;
};

const isRecord = (v: unknown): v is EntryRecord => typeof v === "object" && v !== null && !Array.isArray(v);

type Res = { data: unknown; error: { message: string } | null };

function ok(res: Res, what: string): unknown[] {
  if (res.error) throw new Error(`${what}の読込に失敗しました: ${res.error.message}`);
  if (!Array.isArray(res.data)) throw new Error(`${what}の読込に失敗しました: 応答の形式が不正です`);
  return res.data;
}

/** .in() に渡す ID が多いと URL が長くなりすぎるので、分けて問い合わせる */
async function inChunks(ids: readonly (string | number)[], fn: (chunk: (string | number)[]) => PromiseLike<Res>, what: string, size = 200) {
  const out: unknown[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...ok(await fn(ids.slice(i, i + size)), what));
  return out;
}

/**
 * 人の確認の履歴を読む（読取専用）。ログインした担当者の権限（RLS）で読み、すべての業務データを customer_id で明示して絞る。
 * 顧客が見えない（権限外・存在しない・UUID でない）ときは null を返し、履歴は読まない。
 * 読込の失敗・形式の不正・他の顧客の行の混入は、空の結果にせず例外にする。
 * 関連する行（判断・明細・マスタ名・担当者名）が読めないときは、その項目だけを欠落として返す（履歴自体は消さない）。
 */
export async function loadReviewHistory(client: SupabaseClient, customerId: string, page: number): Promise<ReviewHistory | null> {
  if (!UUID.test(customerId)) return null;
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) throw new Error("ページ番号が正しくありません");

  const customerRes = await client.from("customers").select("id, name").eq("id", customerId).maybeSingle();
  if (customerRes.error) throw new Error(`顧客の読込に失敗しました: ${customerRes.error.message}`);
  const customer = z.object({ id: z.string(), name: z.string() }).nullable().parse(customerRes.data); // undefined は不正
  if (!customer) return null;
  if (customer.id !== customerId) throw new Error("顧客の読込結果が要求と一致しません");

  // 1ページ分＋次のページがあるかを見るための1件を読む。サーバー側の1回の上限で切れても、
  // 必要な件数に届くか、空の応答が返るまで続けて読む（上限で黙って切れた結果を最終ページとみなさない）
  const from = (page - 1) * HISTORY_PAGE_SIZE;
  const want = HISTORY_PAGE_SIZE + 1;
  const raw: unknown[] = [];
  while (raw.length < want) {
    const res = await client
      .from("human_reviews")
      .select("id, customer_id, ai_decision_id, action, final_entry, diff, reason, reviewer_id, bulk, created_at")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from + raw.length, from + want - 1);
    const part = ok(res, "確認の履歴");
    if (part.length === 0) break;
    raw.push(...part.slice(0, want - raw.length));
  }
  const parsed = z.array(reviewSchema).parse(raw);
  if (parsed.some((r) => r.customer_id !== customerId)) throw new Error("他の顧客の確認が含まれていたため読込を中止しました");
  if (new Set(parsed.map((r) => r.id)).size !== parsed.length) throw new Error("確認IDが重複しています");
  const reviews = parsed.slice(0, HISTORY_PAGE_SIZE);
  const more = parsed.length > HISTORY_PAGE_SIZE;
  // MAX_PAGE の次のページは parseHistoryPage が 1 に戻すため、到達できないリンクは作らない
  const hasNext = more && page < MAX_PAGE;
  const olderBeyondLimit = more && page >= MAX_PAGE;

  const decisions = new Map(
    z
      .array(decisionSchema)
      .parse(
        await inChunks(
          [...new Set(reviews.map((r) => r.ai_decision_id))],
          (ids) => client.from("ai_decisions").select("id, customer_id, bank_transaction_id, proposal").eq("customer_id", customerId).in("id", ids),
          "仕訳候補",
        ),
      )
      .map((d) => {
        if (d.customer_id !== customerId) throw new Error("他の顧客の仕訳候補が含まれていたため読込を中止しました");
        return [d.id, d] as const;
      }),
  );

  const txns = new Map(
    z
      .array(txnSchema)
      .parse(
        await inChunks(
          [...new Set([...decisions.values()].map((d) => d.bank_transaction_id))],
          (ids) =>
            client.from("bank_transactions").select("id, customer_id, txn_date, amount, direction, description").eq("customer_id", customerId).in("id", ids),
          "明細",
        ),
      )
      .map((t) => {
        if (t.customer_id !== customerId) throw new Error("他の顧客の明細が含まれていたため読込を中止しました");
        return [t.id, t] as const;
      }),
  );

  // 担当者は自分以外の名前を読めない（RLS）ので、読めない人は名前なし（表示側で「担当者」）にする
  const staffNames = new Map(
    z
      .array(staffSchema)
      .parse(
        await inChunks(
          [...new Set(reviews.map((r) => r.reviewer_id))],
          (ids) => client.from("staff_members").select("user_id, display_name").in("user_id", ids),
          "担当者",
        ),
      )
      .map((s) => [s.user_id, s.display_name] as const),
  );

  const rows: HistoryRow[] = reviews.map((r) => {
    const d = decisions.get(r.ai_decision_id);
    const t = d ? txns.get(d.bank_transaction_id) : undefined;
    const diffRaw = isRecord(r.diff) ? r.diff : {};
    return {
      reviewId: r.id,
      action: r.action,
      at: r.created_at,
      bulk: r.bulk,
      reviewer: { id: r.reviewer_id, name: staffNames.get(r.reviewer_id) ?? null },
      reason: r.reason,
      decisionId: r.ai_decision_id,
      txn: t ? { id: t.id, date: t.txn_date, amount: t.amount, direction: t.direction, description: t.description } : null,
      proposal: !d ? { state: "unavailable" } : isRecord(d.proposal) ? { state: "ok", entry: d.proposal } : d.proposal == null ? { state: "none" } : { state: "unavailable" },
      finalEntry: isRecord(r.final_entry) ? r.final_entry : null,
      diff: Object.entries(diffRaw).map(([field, v]) => ({
        field,
        before: isRecord(v) ? v.before : undefined,
        after: isRecord(v) ? v.after : undefined,
      })),
    };
  });

  // 表示する ID の名前をマスタから引く（無効になったマスタも名前は出すので available では絞らない）
  const ids = new Set<number>();
  const collect = (v: unknown) => {
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "number" && Number.isSafeInteger(x)) ids.add(x);
  };
  for (const row of rows) {
    for (const e of [row.finalEntry, row.proposal.state === "ok" ? row.proposal.entry : null]) {
      if (e) for (const k of ID_FIELDS) collect(e[k]);
    }
    for (const x of row.diff) {
      collect(x.before);
      collect(x.after);
    }
  }
  const masters: MasterNames = new Map();
  for (const m of z
    .array(masterSchema)
    .parse(
      await inChunks(
        [...ids],
        (chunk) => client.from("freee_masters").select("customer_id, kind, freee_id, name, available").eq("customer_id", customerId).in("freee_id", chunk),
        "マスタ",
        // 同じ freee_id が種類ごとに最大6行返るので、PostgREST の既定の上限（1,000行）に収まる数にする
        100,
      ),
    )) {
    if (m.customer_id !== customerId) throw new Error("他の顧客のマスタが含まれていたため読込を中止しました");
    masters.set(masterKey(m.kind, m.freee_id), { name: m.name, available: m.available });
  }

  return {
    customer: { id: customer.id, name: customer.name },
    page,
    pageSize: HISTORY_PAGE_SIZE,
    rows,
    hasPrevious: page > 1,
    hasNext,
    olderBeyondLimit,
    masters,
  };
}

/** 仕訳の項目と、名前を引くマスタの種類（順序は表示順） */
export const ENTRY_FIELDS = [
  { key: "account_item_id", label: "勘定科目", kind: "account_item" },
  { key: "tax_code", label: "税区分", kind: "tax" },
  { key: "partner_id", label: "取引先", kind: "partner" },
  { key: "item_id", label: "品目", kind: "item" },
  { key: "section_id", label: "部門", kind: "section" },
  { key: "tag_ids", label: "メモタグ", kind: "tag" },
  { key: "description", label: "摘要", kind: null },
] as const;
const ID_FIELDS = ENTRY_FIELDS.filter((f) => f.kind !== null).map((f) => f.key);
