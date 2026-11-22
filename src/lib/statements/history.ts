import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { HISTORY_PAGE_SIZE, MAX_PAGE, parseHistoryPage } from "@/lib/review/history";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 1ページの件数・ページ番号の上限・?page= の解釈は、確認の履歴と同じ */
export const IMPORT_PAGE_SIZE = HISTORY_PAGE_SIZE;
export const IMPORT_MAX_PAGE = MAX_PAGE;
export const parseImportPage = parseHistoryPage;
/** 金額0の行・読めなかった行を1件の取込で表示する上限。超えた分は件数だけ示す */
export const MAX_DETAIL_ITEMS = 100;

/** 件数・金額（bigint は数値でも文字列でも返り得る）。0 以上の安全な整数だけを受け付け、桁あふれで丸められた値は拒否する */
const amount = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.number().int().nonnegative().safe());

const importSchema = z.object({
  id: z.string().min(1),
  customer_id: z.string(),
  wallet_id: z.string(),
  source: z.enum(["csv", "freee_wallet_txns"]),
  file_name: z.string().nullable(),
  csv_format: z.string().nullable(),
  imported_by: z.string().nullable(),
  imported_at: z.string().min(1),
  status: z.enum(["completed", "failed"]),
  source_row_count: amount.nullable(),
  row_count: amount,
  inserted_count: amount,
  skipped_duplicate_count: amount,
  suspected_duplicate_count: amount,
  ignored_rows: z.unknown(),
  errors: z.unknown(),
  income_total: amount,
  expense_total: amount,
  inserted_amount_total: amount,
  skipped_amount_total: amount,
  suspected_amount_total: amount,
});
const walletSchema = z.object({ id: z.string(), customer_id: z.string(), name: z.string() });
const staffSchema = z.object({ user_id: z.string(), display_name: z.string() });
/** 行番号。0 はファイル全体の誤り（現在の解析の出力）を表す。負数は不正 */
const lineNo = z.number().int().nonnegative().safe();
const ignoredItem = z.object({ line: lineNo, reason: z.string() });
const errorItem = z.object({ line: lineNo, message: z.string() });

export type DetailItem = { line: number; text: string };
/** 金額0の行・読めなかった行。jsonb の形が想定と違うときは invalid（空の一覧にはしない） */
export type DetailList = { state: "ok"; items: DetailItem[]; total: number; omitted: number } | { state: "invalid" };

export type ImportRecord = {
  importId: string;
  at: string;
  source: "csv" | "freee_wallet_txns";
  status: "completed" | "failed";
  fileName: string | null;
  csvFormat: string | null;
  /** 口座名が読めないときは name が null */
  wallet: { id: string; name: string | null };
  /** imported_by が null（記録なし）のときは id も null。名前が読めないときは name だけ null */
  importer: { id: string | null; name: string | null };
  /** null は記録なし（旧形式など）。0 とは区別する */
  sourceRowCount: number | null;
  counts: { read: number; inserted: number; skipped: number; suspected: number };
  amounts: { income: number; expense: number; inserted: number; skipped: number; suspected: number };
  ignored: DetailList;
  errors: DetailList;
  /** 件数・金額の照合で見つかった不整合。空でも「正しい」ことの証明ではなく、確認した範囲で矛盾がないという意味 */
  warnings: string[];
};

export type ImportHistory = {
  customer: { id: string; name: string };
  page: number;
  pageSize: number;
  rows: ImportRecord[];
  hasPrevious: boolean;
  /** 次のページへのリンクを出してよいか。表示できる最終ページ（IMPORT_MAX_PAGE）では、より古い記録があっても false */
  hasNext: boolean;
  /** 表示できる最終ページより古い記録がある（この画面では辿れない） */
  olderBeyondLimit: boolean;
};

type Res = { data: unknown; error: { message: string } | null };

function ok(res: Res, what: string): unknown[] {
  if (res.error) throw new Error(`${what}の読込に失敗しました: ${res.error.message}`);
  if (!Array.isArray(res.data)) throw new Error(`${what}の読込に失敗しました: 応答の形式が不正です`);
  return res.data;
}

/** .in() に渡す ID が多いと URL が長くなりすぎるので、分けて問い合わせる */
async function inChunks(ids: readonly string[], fn: (chunk: string[]) => PromiseLike<Res>, what: string, size = 200) {
  const out: unknown[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...ok(await fn(ids.slice(i, i + size)), what));
  return out;
}

function detail<T extends z.ZodTypeAny>(raw: unknown, schema: T, text: (v: z.infer<T>) => DetailItem): DetailList {
  const parsed = z.array(schema).safeParse(raw);
  if (!parsed.success) return { state: "invalid" };
  const all = parsed.data.map(text);
  return { state: "ok", items: all.slice(0, MAX_DETAIL_ITEMS), total: all.length, omitted: Math.max(0, all.length - MAX_DETAIL_ITEMS) };
}

/** 合計が安全な整数に収まらないときは null（丸めた値で照合しない） */
const sum = (...n: number[]): number | null => {
  const s = n.reduce((a, b) => a + b, 0);
  return Number.isSafeInteger(s) ? s : null;
};

/**
 * 取込記録の件数・金額の照合（DB の制約 statement_imports_reconciled / _failed_has_errors と同じ内容を、読んだ値で確かめ直す）。
 * 失敗の記録は取込がなかったことを表すので、件数・金額が 0 であることだけを確かめる。
 */
function reconcile(r: Omit<ImportRecord, "warnings">): string[] {
  const w: string[] = [];
  const { counts: c, amounts: a } = r;
  if (r.ignored.state === "invalid") w.push("金額0の行の記録の形式が不正で、表示できません");
  if (r.errors.state === "invalid") w.push("読めなかった行の記録の形式が不正で、表示できません");
  if (r.status === "failed") {
    if (c.read !== 0 || c.inserted !== 0 || c.skipped !== 0 || c.suspected !== 0) w.push("失敗の記録なのに、取り込んだ件数が 0 ではありません");
    if (a.income !== 0 || a.expense !== 0 || a.inserted !== 0 || a.skipped !== 0 || a.suspected !== 0) w.push("失敗の記録なのに、金額が 0 ではありません");
    if (r.errors.state === "ok" && r.errors.total === 0) w.push("失敗の記録なのに、読めなかった行の理由がありません");
    return w;
  }
  const split = sum(c.inserted, c.skipped, c.suspected);
  if (split === null || split !== c.read) w.push(`件数が合いません: 読めた行 ${c.read} 件に対し、登録 + 読み飛ばし + 重複の疑い = ${split ?? "（大きすぎて計算できません）"} 件`);
  const total = sum(a.income, a.expense);
  const parts = sum(a.inserted, a.skipped, a.suspected);
  if (total === null || parts === null) w.push("金額の合計が大きすぎて照合できません");
  else if (total !== parts) w.push(`金額が合いません: 入金 + 出金 = ${total.toLocaleString("ja-JP")} 円に対し、登録 + 読み飛ばし + 重複の疑い = ${parts.toLocaleString("ja-JP")} 円`);
  if (r.sourceRowCount !== null && r.ignored.state === "ok" && r.errors.state === "ok") {
    const expected = sum(c.read, r.ignored.total, r.errors.total);
    if (expected === null || expected !== r.sourceRowCount) {
      w.push(`行数が合いません: 元の行数 ${r.sourceRowCount} に対し、読めた行 + 金額0の行 + 読めなかった行 = ${expected ?? "（大きすぎて計算できません）"}`);
    }
  }
  return w;
}

/**
 * 顧客の明細取込の記録を読む（読取専用）。ログインした担当者の権限（RLS）で読み、顧客を持つ表は customer_id で明示して絞る。
 * 顧客が見えない（権限外・存在しない・UUID でない）ときは null を返し、記録は読まない。
 * 読込の失敗・形式の不正・他の顧客の行の混入・件数や金額が安全な整数でない記録は、空の結果にせず例外にする。
 * 口座名・取込者名が読めないときは、その項目だけ欠落として返す（取込の記録自体は消さない）。
 */
export async function loadImportHistory(client: SupabaseClient, customerId: string, page: number): Promise<ImportHistory | null> {
  if (!UUID.test(customerId)) return null;
  if (!Number.isInteger(page) || page < 1 || page > IMPORT_MAX_PAGE) throw new Error("ページ番号が正しくありません");

  const customerRes = await client.from("customers").select("id, name").eq("id", customerId).maybeSingle();
  if (customerRes.error) throw new Error(`顧客の読込に失敗しました: ${customerRes.error.message}`);
  const customer = z.object({ id: z.string(), name: z.string() }).nullable().parse(customerRes.data); // undefined は不正
  if (!customer) return null;
  if (customer.id !== customerId) throw new Error("顧客の読込結果が要求と一致しません");

  // 1ページ分＋次のページがあるかを見るための1件を読む。サーバー側の1回の上限で切れても、
  // 必要な件数に届くか、空の応答が返るまで続けて読む（上限で黙って切れた結果を最終ページとみなさない）
  const from = (page - 1) * IMPORT_PAGE_SIZE;
  const want = IMPORT_PAGE_SIZE + 1;
  const raw: unknown[] = [];
  while (raw.length < want) {
    const res = await client
      .from("statement_imports")
      .select(
        "id, customer_id, wallet_id, source, file_name, csv_format, imported_by, imported_at, status, source_row_count, row_count, inserted_count, skipped_duplicate_count, suspected_duplicate_count, ignored_rows, errors, income_total, expense_total, inserted_amount_total, skipped_amount_total, suspected_amount_total",
      )
      .eq("customer_id", customerId)
      .order("imported_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from + raw.length, from + want - 1);
    const part = ok(res, "取込の記録");
    if (part.length === 0) break;
    raw.push(...part.slice(0, want - raw.length));
  }
  const parsed = z.array(importSchema).parse(raw);
  if (parsed.some((r) => r.customer_id !== customerId)) throw new Error("他の顧客の取込記録が含まれていたため読込を中止しました");
  if (new Set(parsed.map((r) => r.id)).size !== parsed.length) throw new Error("取込IDが重複しています");
  const imports = parsed.slice(0, IMPORT_PAGE_SIZE);
  const more = parsed.length > IMPORT_PAGE_SIZE;
  // 最終ページの次は parseImportPage が 1 に戻すため、到達できないリンクは作らない
  const hasNext = more && page < IMPORT_MAX_PAGE;
  const olderBeyondLimit = more && page >= IMPORT_MAX_PAGE;

  const wallets = new Map(
    z
      .array(walletSchema)
      .parse(
        await inChunks(
          [...new Set(imports.map((i) => i.wallet_id))],
          (ids) => client.from("wallets").select("id, customer_id, name").eq("customer_id", customerId).in("id", ids),
          "口座",
        ),
      )
      .map((w) => {
        if (w.customer_id !== customerId) throw new Error("他の顧客の口座が含まれていたため読込を中止しました");
        return [w.id, w.name] as const;
      }),
  );

  // 担当者は自分以外の名前を読めない（RLS）ので、読めない人は名前なしにする
  const staffNames = new Map(
    z
      .array(staffSchema)
      .parse(
        await inChunks(
          [...new Set(imports.flatMap((i) => (i.imported_by ? [i.imported_by] : [])))],
          (ids) => client.from("staff_members").select("user_id, display_name").in("user_id", ids),
          "担当者",
        ),
      )
      .map((s) => [s.user_id, s.display_name] as const),
  );

  const rows: ImportRecord[] = imports.map((i) => {
    const base: Omit<ImportRecord, "warnings"> = {
      importId: i.id,
      at: i.imported_at,
      source: i.source,
      status: i.status,
      fileName: i.file_name,
      csvFormat: i.csv_format,
      wallet: { id: i.wallet_id, name: wallets.get(i.wallet_id) ?? null },
      importer: { id: i.imported_by, name: i.imported_by ? (staffNames.get(i.imported_by) ?? null) : null },
      sourceRowCount: i.source_row_count,
      counts: { read: i.row_count, inserted: i.inserted_count, skipped: i.skipped_duplicate_count, suspected: i.suspected_duplicate_count },
      amounts: {
        income: i.income_total,
        expense: i.expense_total,
        inserted: i.inserted_amount_total,
        skipped: i.skipped_amount_total,
        suspected: i.suspected_amount_total,
      },
      ignored: detail(i.ignored_rows, ignoredItem, (v) => ({ line: v.line, text: v.reason })),
      errors: detail(i.errors, errorItem, (v) => ({ line: v.line, text: v.message })),
    };
    return { ...base, warnings: reconcile(base) };
  });

  return {
    customer: { id: customer.id, name: customer.name },
    page,
    pageSize: IMPORT_PAGE_SIZE,
    rows,
    hasPrevious: page > 1,
    hasNext,
    olderBeyondLimit,
  };
}
