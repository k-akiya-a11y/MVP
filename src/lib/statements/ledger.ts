import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { HISTORY_PAGE_SIZE, MAX_PAGE, parseHistoryPage } from "@/lib/review/history";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 1ページの件数・ページ番号の上限・?page= の解釈は、確認の履歴・取込の記録と同じ */
export const LEDGER_PAGE_SIZE = HISTORY_PAGE_SIZE;
export const LEDGER_MAX_PAGE = MAX_PAGE;
export const parseLedgerPage = parseHistoryPage;

/** bank_transactions.status の取り得る値（20261020000300 の check 制約と同じ） */
export const TXN_STATUSES = ["new", "proposed", "approved", "registered", "on_hold", "rejected", "duplicate_suspected", "duplicate"] as const;
export type TxnStatus = (typeof TXN_STATUSES)[number];

/** 状態の表示名。new は「まだ判定していない」だけを表し、失敗・不可の意味にしない。承認と freee 登録は別 */
export const TXN_STATUS_LABEL: Record<TxnStatus, string> = {
  new: "未判定（仕訳候補は未作成）",
  proposed: "仕訳候補あり（人の確認待ち）",
  approved: "承認済み（freee への登録は、この記録では確認できていません）",
  registered: "freee 登録済み（記録上）",
  on_hold: "保留",
  rejected: "却下",
  duplicate_suspected: "重複の疑い（人の確認待ち）",
  duplicate: "重複として除外済み",
};

/** 絞り込み。null は「指定なし」。日付は取引日（その日を含む） */
export type LedgerFilters = { status: TxnStatus | null; walletId: string | null; from: string | null; to: string | null };
export const NO_FILTERS: LedgerFilters = { status: null, walletId: null, from: null, to: null };
export const isFiltered = (f: LedgerFilters) => f.status !== null || f.walletId !== null || f.from !== null || f.to !== null;

/** YYYY-MM-DD の実在する日付か（閏日を含めて検証。2026-02-29 などは偽） */
export function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1) return false;
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

type RawParam = string | string[] | undefined;

/**
 * ?status= ?wallet= ?from= ?to= の解釈。空・未指定は「指定なし」（status は all も同じ）。
 * 不正・実在しない日付・逆順・複数回の指定は、黙って捨てずに errors に固定文で返す（入力値は含めない）。
 * filters には、それ自体が有効な項目だけが入る。errors があるときは、この filters で明細を読んではならない。
 */
export function parseLedgerFilters(raw: { status?: RawParam; wallet?: RawParam; from?: RawParam; to?: RawParam }): {
  filters: LedgerFilters;
  errors: string[];
} {
  const errors: string[] = [];
  const filters: LedgerFilters = { ...NO_FILTERS };
  const single = (key: "status" | "wallet" | "from" | "to", label: string): string | null => {
    const v = raw[key];
    if (Array.isArray(v)) {
      errors.push(`「${label}」が複数回指定されています。1つだけ指定してください。`);
      return null;
    }
    return v === undefined || v === "" ? null : v;
  };

  const status = single("status", "状態");
  if (status !== null && status !== "all") {
    if ((TXN_STATUSES as readonly string[]).includes(status)) filters.status = status as TxnStatus;
    else errors.push("「状態」の指定が正しくありません。一覧から選び直してください。");
  }
  const wallet = single("wallet", "口座");
  if (wallet !== null) {
    if (UUID.test(wallet)) filters.walletId = wallet.toLowerCase();
    else errors.push("「口座」の指定が正しくありません。一覧から選び直してください。");
  }
  for (const [key, label] of [["from", "開始日"], ["to", "終了日"]] as const) {
    const v = single(key, label);
    if (v === null) continue;
    if (isRealDate(v)) filters[key] = v;
    else errors.push(`「${label}」は、実在する日付を YYYY-MM-DD の形式（例 2026-10-31）で指定してください。`);
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    errors.push("「開始日」が「終了日」より後になっています。開始日が終了日以前になるように指定してください。");
  }
  return { filters, errors };
}

/** 一覧のURL。有効な絞り込みだけを URLSearchParams で組み立てる（1ページ目は page を付けない） */
export function ledgerHref(customerId: string, filters: LedgerFilters, page: number): string {
  const p = new URLSearchParams();
  if (filters.status) p.set("status", filters.status);
  if (filters.walletId) p.set("wallet", filters.walletId);
  if (filters.from) p.set("from", filters.from);
  if (filters.to) p.set("to", filters.to);
  if (page > 1) p.set("page", String(page));
  const q = p.toString();
  return `/customers/${customerId}/statements${q ? `?${q}` : ""}`;
}

/** 口座の選択肢の最大件数。超えたら一部のみ表示と示す */
export const WALLET_OPTION_LIMIT = 200;

/** 金額（円）。0 より大きい安全な整数だけ。bigint は文字列でも返り得るが、丸められた値は拒否する */
const amount = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.number().int().positive().safe());

const txnSchema = z.object({
  id: z.string().min(1),
  customer_id: z.string(),
  wallet_id: z.string(),
  import_id: z.string(),
  txn_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount,
  direction: z.enum(["income", "expense"]),
  description: z.string(),
  status: z.enum(TXN_STATUSES),
  duplicate_of_id: z.string().nullable(),
});
const walletSchema = z.object({ id: z.string(), customer_id: z.string(), name: z.string() });

export type LedgerRow = {
  id: string;
  date: string;
  direction: "income" | "expense";
  amount: number;
  description: string;
  status: TxnStatus;
  importId: string;
  duplicateOfId: string | null;
  /** 口座名が読めないときは name が null */
  wallet: { id: string; name: string | null };
};

export type Ledger = {
  customer: { id: string; name: string };
  /** 適用した絞り込み（読込に渡した値）。読まなかったとき（filters が null）は指定なし */
  filters: LedgerFilters;
  /** この顧客の口座の選択肢（名前順）。顧客で絞って読む */
  walletOptions: { id: string; name: string }[];
  /** 口座が多く、選択肢を一部しか読んでいない */
  walletOptionsTruncated: boolean;
  /** 指定された口座が、この顧客の口座として確認できなかった（他顧客・存在しないを区別しない）。明細は読んでいない */
  walletUnavailable: boolean;
  page: number;
  pageSize: number;
  rows: LedgerRow[];
  hasPrevious: boolean;
  /** 次のページへのリンクを出してよいか。表示できる最終ページでは、より古い明細があっても false */
  hasNext: boolean;
  /** 表示できる最終ページより古い明細がある（この画面では辿れない） */
  olderBeyondLimit: boolean;
};

type Res = { data: unknown; error: { message: string } | null };

function ok(res: Res, what: string): unknown[] {
  if (res.error) throw new Error(`${what}の読込に失敗しました: ${res.error.message}`);
  if (!Array.isArray(res.data)) throw new Error(`${what}の読込に失敗しました: 応答の形式が不正です`);
  return res.data;
}

/**
 * 顧客の明細を状態を問わず読む（読取専用）。ログインした担当者の権限（RLS）で読み、customer_id で明示して絞る。
 * 顧客が見えない（権限外・存在しない・UUID でない）ときは null を返し、明細は読まない。
 * 読込の失敗・形式の不正・未知の状態・他の顧客の行の混入・金額が安全な正の整数でない行は、空の結果にせず例外にする。
 * 口座名が読めないときは、その項目だけ欠落として返す（明細自体は消さない）。
 * filters は SQL 側（eq / gte / lte）で、並び・ページ範囲より前に適用する。読んだ後に画面側で絞ることはしない。
 * filters が null のときは、入力が無効だったことを表し、顧客と口座の選択肢だけを読んで明細は読まない。
 */
export async function loadLedger(
  client: SupabaseClient,
  customerId: string,
  page: number,
  filters: LedgerFilters | null = NO_FILTERS,
): Promise<Ledger | null> {
  if (!UUID.test(customerId)) return null;
  if (!Number.isInteger(page) || page < 1 || page > LEDGER_MAX_PAGE) throw new Error("ページ番号が正しくありません");

  const customerRes = await client.from("customers").select("id, name").eq("id", customerId).maybeSingle();
  if (customerRes.error) throw new Error(`顧客の読込に失敗しました: ${customerRes.error.message}`);
  const customer = z.object({ id: z.string(), name: z.string() }).nullable().parse(customerRes.data); // undefined は不正
  if (!customer) return null;
  if (customer.id !== customerId) throw new Error("顧客の読込結果が要求と一致しません");

  // 口座の選択肢（顧客で絞る）。1回の応答上限で切れても、上限件数を超えるか空の応答になるまで続けて読む
  const optRaw: unknown[] = [];
  const optWant = WALLET_OPTION_LIMIT + 1;
  while (optRaw.length < optWant) {
    const res = await client
      .from("wallets")
      .select("id, customer_id, name")
      .eq("customer_id", customerId)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(optRaw.length, optWant - 1);
    const part = z.array(walletSchema).parse(ok(res, "口座"));
    if (part.some((w) => w.customer_id !== customerId)) throw new Error("他の顧客の口座が含まれていたため読込を中止しました");
    if (part.length === 0) break;
    optRaw.push(...part.slice(0, optWant - optRaw.length));
  }
  const optAll = z.array(walletSchema).parse(optRaw);
  if (new Set(optAll.map((w) => w.id)).size !== optAll.length) throw new Error("口座IDが重複しています");
  const walletOptionsTruncated = optAll.length > WALLET_OPTION_LIMIT;
  const walletOptions = optAll.slice(0, WALLET_OPTION_LIMIT).map((w) => ({ id: w.id.toLowerCase(), name: w.name }));

  const base = { customer: { id: customer.id, name: customer.name }, walletOptions, walletOptionsTruncated };
  const empty = (f: LedgerFilters, walletUnavailable: boolean): Ledger => ({
    ...base,
    filters: f,
    walletUnavailable,
    page,
    pageSize: LEDGER_PAGE_SIZE,
    rows: [],
    hasPrevious: page > 1,
    hasNext: false,
    olderBeyondLimit: false,
  });
  if (filters === null) return empty(NO_FILTERS, false);

  // 選んだ口座がこの顧客のものか確認する。選択肢に無く一部しか読んでいないときは、顧客で絞って1件だけ確かめる。
  // 確認できなければ明細は読まない（他顧客の口座・存在しない口座で条件を広げない。名前も返さない）
  if (filters.walletId && !walletOptions.some((w) => w.id === filters.walletId)) {
    let found = false;
    if (walletOptionsTruncated) {
      const res = await client.from("wallets").select("id, customer_id, name").eq("customer_id", customerId).eq("id", filters.walletId);
      const hit = z.array(walletSchema).parse(ok(res, "口座"));
      if (hit.some((w) => w.customer_id !== customerId)) throw new Error("他の顧客の口座が含まれていたため読込を中止しました");
      found = hit.some((w) => w.id.toLowerCase() === filters.walletId);
      if (found) walletOptions.push({ id: filters.walletId, name: hit[0]!.name });
    }
    if (!found) return empty(filters, true);
  }

  // 1ページ分＋次のページがあるかを見るための1件を読む。サーバー側の1回の上限で切れても、
  // 必要な件数に届くか、空の応答が返るまで続けて読む（上限で黙って切れた結果を最終ページとみなさない）。
  // 絞り込みは毎回同じ条件を並び・範囲より前に付ける
  const from = (page - 1) * LEDGER_PAGE_SIZE;
  const want = LEDGER_PAGE_SIZE + 1;
  const raw: unknown[] = [];
  while (raw.length < want) {
    let q = client
      .from("bank_transactions")
      .select("id, customer_id, wallet_id, import_id, txn_date, amount, direction, description, status, duplicate_of_id")
      .eq("customer_id", customerId);
    if (filters.status) q = q.eq("status", filters.status);
    if (filters.walletId) q = q.eq("wallet_id", filters.walletId);
    if (filters.from) q = q.gte("txn_date", filters.from);
    if (filters.to) q = q.lte("txn_date", filters.to);
    const res = await q
      .order("txn_date", { ascending: false })
      .order("id", { ascending: false })
      .range(from + raw.length, from + want - 1);
    const part = ok(res, "明細");
    if (part.length === 0) break;
    raw.push(...part.slice(0, want - raw.length));
  }
  const parsed = z.array(txnSchema).parse(raw);
  if (parsed.some((r) => r.customer_id !== customerId)) throw new Error("他の顧客の明細が含まれていたため読込を中止しました");
  if (
    parsed.some(
      (r) =>
        (filters.status && r.status !== filters.status) ||
        (filters.walletId && r.wallet_id.toLowerCase() !== filters.walletId) ||
        (filters.from && r.txn_date < filters.from) ||
        (filters.to && r.txn_date > filters.to),
    )
  ) {
    throw new Error("絞り込み条件に合わない明細が含まれていたため読込を中止しました");
  }
  if (new Set(parsed.map((r) => r.id)).size !== parsed.length) throw new Error("明細IDが重複しています");
  const txns = parsed.slice(0, LEDGER_PAGE_SIZE);
  const more = parsed.length > LEDGER_PAGE_SIZE;
  const hasNext = more && page < LEDGER_MAX_PAGE;
  const olderBeyondLimit = more && page >= LEDGER_MAX_PAGE;

  // 口座名は顧客で絞って読む。.in() の URL が長くなりすぎないよう分けて問い合わせる（1ページ最大50件なので口座は少数）
  const walletIds = [...new Set(txns.map((t) => t.wallet_id))];
  const walletRaw: unknown[] = [];
  for (let i = 0; i < walletIds.length; i += 200) {
    const res = await client
      .from("wallets")
      .select("id, customer_id, name")
      .eq("customer_id", customerId)
      .in("id", walletIds.slice(i, i + 200));
    walletRaw.push(...ok(res, "口座"));
  }
  const wallets = new Map(
    z
      .array(walletSchema)
      .parse(walletRaw)
      .map((w) => {
        if (w.customer_id !== customerId) throw new Error("他の顧客の口座が含まれていたため読込を中止しました");
        return [w.id, w.name] as const;
      }),
  );

  const rows: LedgerRow[] = txns.map((t) => ({
    id: t.id,
    date: t.txn_date,
    direction: t.direction,
    amount: t.amount,
    description: t.description,
    status: t.status,
    importId: t.import_id,
    duplicateOfId: t.duplicate_of_id,
    wallet: { id: t.wallet_id, name: wallets.get(t.wallet_id) ?? null },
  }));

  return { ...base, filters, walletUnavailable: false, page, pageSize: LEDGER_PAGE_SIZE, rows, hasPrevious: page > 1, hasNext, olderBeyondLimit };
}
