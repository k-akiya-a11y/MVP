import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { fetchAll } from "../supabase/fetch-all";
import type { MasterKind } from "../proposals/types";

/**
 * DB の応答の整数。数値は安全な整数だけ、文字列は 10 進の整数（符号は "-" のみ、空白・指数・16進・小数は不可）だけを通す。
 * null・空文字・真偽値・配列は 0 / 1 に変換せず拒否する。"-0" は 0 にする。
 * ID が正であるべきか等の値域は見ない（tax_code の 0 や過去仕訳の負の金額は正当）。
 */
const int = z
  .union([z.number(), z.string().regex(/^-?[0-9]+$/)])
  .transform(Number)
  .pipe(z.number().refine((n) => Number.isSafeInteger(n)))
  .transform((n) => (n === 0 ? 0 : n));

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
  /** この仕訳候補の保留の記録（古い順）。保留した人の理由を承認者が読んで判断する */
  holds: { reason: string | null; reviewerName: string; at: string }[];
};

export type MasterOption = { id: number; name: string };

/** 取込済みの明細と区別できず「重複の疑い」になった明細と、同じキーを持つ取込済みの明細 */
export type SuspectedDuplicate = {
  id: string;
  date: string;
  amount: number;
  direction: "income" | "expense";
  description: string;
  walletName: string;
  original: { id: string; date: string; amount: number; description: string; status: string };
};

export type ReviewQueue = {
  customer: { id: string; name: string };
  /** 承認・修正・却下・重複の除外ができるか（承認者＝管理者だけ。DB の関数でも同じ判定をする） */
  canApprove: boolean;
  items: ReviewItem[];
  suspectedDuplicates: SuspectedDuplicate[];
  masters: Record<MasterKind, MasterOption[]>;
  wallets: { id: string; name: string; kind: string }[];
};

/**
 * 必須の関連行（最新の判断・重複元）が全件読込後も揃わないときの失敗。
 * 利用者に出てもよい固定の文言だけを持ち、ID・顧客・DB の応答は含めない。
 */
export class ReviewQueueLoadError extends Error {
  constructor() {
    super("承認画面のデータを読み込めませんでした。時間をおいて再読み込みしてください。");
    this.name = "ReviewQueueLoadError";
  }
}

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

  const [txnsRes, mastersRes, walletsRes, suspectsRes, adminRes] = await Promise.all([
    fetchAll("明細", (from, to) =>
      client
        .from("bank_transactions")
        .select("id, wallet_id, txn_date, amount, direction, description, status")
        .eq("customer_id", customerId)
        .in("status", ["proposed", "on_hold"])
        .order("txn_date")
        .order("id")
        .range(from, to),
    ),
    fetchAll("マスタ", (from, to) =>
      client
        .from("freee_masters")
        .select("kind, freee_id, name")
        .eq("customer_id", customerId)
        .eq("available", true)
        .order("kind")
        .order("freee_id")
        .range(from, to),
    ),
    fetchAll("口座", (from, to) =>
      client.from("wallets").select("id, name, kind").eq("customer_id", customerId).order("name").order("id").range(from, to),
    ),
    fetchAll("重複の疑い", (from, to) =>
      client
        .from("bank_transactions")
        .select("id, wallet_id, txn_date, amount, direction, description, duplicate_of_id")
        .eq("customer_id", customerId)
        .eq("status", "duplicate_suspected")
        .order("txn_date")
        .order("id")
        .range(from, to),
    ),
    client.rpc("is_admin"),
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
    .parse(txnsRes);
  const wallets = z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() })).parse(walletsRes);
  const walletNames = new Map(wallets.map((w) => [w.id, w.name]));

  const masters: ReviewQueue["masters"] = { account_item: [], tax: [], partner: [], item: [], section: [], tag: [] };
  for (const m of z
    .array(z.object({ kind: z.enum(["account_item", "partner", "item", "section", "tag", "tax"]), freee_id: int, name: z.string() }))
    .parse(mastersRes)) {
    masters[m.kind].push({ id: m.freee_id, name: m.name });
  }

  // 以降の関連行は、ID を 200 件ずつに分け、各チャンクを一意な order 付きで fetchAll する。
  // サーバーの応答上限（max-rows）が 200 や 1,000 を下回っても、保留のような 1 対多の行が切れない。
  const decisions = (
    await inChunks(txns.map((t) => t.id), (ids) =>
      fetchAll("仕訳候補", (from, to) =>
        client
          .from("latest_ai_decisions")
          .select("id, bank_transaction_id, created_at, confidence, proposal, confidence_breakdown, past_entry_ids, ai_reason, ai_unknowns, model")
          .eq("customer_id", customerId)
          .in("bank_transaction_id", ids)
          .order("bank_transaction_id")
          .order("id")
          .range(from, to),
      ),
    )
  ).flatMap((rows) =>
    z
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
      .parse(rows),
  );
  const decisionByTxn = new Map(decisions.map((d) => [d.bank_transaction_id, d]));
  // view は明細ごとに 1 件のはず。重複していたらどちらが最新か決められないので止める
  if (decisionByTxn.size !== decisions.length) throw new ReviewQueueLoadError();

  const pastIds = [...new Set(decisions.flatMap((d) => d.past_entry_ids))];
  const pastRows = (
    await inChunks(pastIds, (ids) =>
      fetchAll("過去仕訳", (from, to) =>
        client
          .from("past_journal_entries")
          .select("id, entry_date, amount, bank_description, account_item_id, tax_code, partner_id, item_id, section_id, tag_ids, description")
          .eq("customer_id", customerId)
          .in("id", ids)
          .order("id")
          .range(from, to),
      ),
    )
  ).flatMap((rows) =>
    z
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
      .parse(rows),
  );
  const pastById = new Map(pastRows.map((p) => [p.id, p]));

  // 保留は 1 つの判断に何件も付く。判断ごとに同じチャンクへ入るので、created_at → id の順が判断内で保たれる
  const holdRows = (
    await inChunks(decisions.map((d) => d.id), (ids) =>
      fetchAll("保留の記録", (from, to) =>
        client
          .from("human_reviews")
          .select("ai_decision_id, reason, reviewer_id, created_at")
          .eq("customer_id", customerId)
          .eq("action", "hold")
          .in("ai_decision_id", ids)
          .order("created_at")
          .order("id")
          .range(from, to),
      ),
    )
  ).flatMap((rows) =>
    z
      .array(z.object({ ai_decision_id: z.string(), reason: z.string().nullable(), reviewer_id: z.string(), created_at: z.string() }))
      .parse(rows),
  );
  // 担当者は自分以外の名前を読めない（RLS）ので、読めない人は「担当者」と表示する。staff_members は顧客を持たない
  const reviewerIds = [...new Set(holdRows.map((h) => h.reviewer_id))];
  const reviewerNames = new Map(
    (
      await inChunks(reviewerIds, (ids) =>
        fetchAll("担当者", (from, to) =>
          client.from("staff_members").select("user_id, display_name").in("user_id", ids).order("user_id").range(from, to),
        ),
      )
    )
      .flatMap((rows) => z.array(z.object({ user_id: z.string(), display_name: z.string() })).parse(rows))
      .map((s) => [s.user_id, s.display_name] as const),
  );
  const holdsByDecision = new Map<string, ReviewItem["holds"]>();
  for (const h of holdRows) {
    const list = holdsByDecision.get(h.ai_decision_id) ?? [];
    list.push({ reason: h.reason, reviewerName: reviewerNames.get(h.reviewer_id) ?? "担当者", at: h.created_at });
    holdsByDecision.set(h.ai_decision_id, list);
  }

  const items: ReviewItem[] = [];
  for (const t of txns) {
    const d = decisionByTxn.get(t.id);
    // 候補作成済・保留の明細には必ず最新の判断がある。全件読んでも無いなら、キューを黙って縮めず読込失敗にする
    if (!d) throw new ReviewQueueLoadError();
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
      holds: holdsByDecision.get(d.id) ?? [],
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

  const suspects = z
    .array(
      z.object({
        id: z.string(),
        wallet_id: z.string(),
        txn_date: z.string(),
        amount: int,
        direction: z.enum(["income", "expense"]),
        description: z.string(),
        duplicate_of_id: z.string(),
      }),
    )
    .parse(suspectsRes);
  const originals = new Map(
    (
      await inChunks([...new Set(suspects.map((r) => r.duplicate_of_id))], (ids) =>
        fetchAll("取込済みの明細", (from, to) =>
          client
            .from("bank_transactions")
            .select("id, txn_date, amount, description, status")
            .eq("customer_id", customerId)
            .in("id", ids)
            .order("id")
            .range(from, to),
        ),
      )
    )
      .flatMap((rows) =>
        z.array(z.object({ id: z.string(), txn_date: z.string(), amount: int, description: z.string(), status: z.string() })).parse(rows),
      )
      .map((o) => [o.id, o] as const),
  );
  const suspectedDuplicates: SuspectedDuplicate[] = suspects.flatMap((r) => {
    const o = originals.get(r.duplicate_of_id);
    // 重複元は同じ顧客に必ずある（外部キー）。全件読んでも無いなら、未処理の疑いを隠さず読込失敗にする
    if (!o) throw new ReviewQueueLoadError();
    return [
      {
        id: r.id,
        date: r.txn_date,
        amount: r.amount,
        direction: r.direction,
        description: r.description,
        walletName: walletNames.get(r.wallet_id) ?? "",
        original: { id: o.id, date: o.txn_date, amount: o.amount, description: o.description, status: o.status },
      },
    ];
  });

  return {
    customer: { id: customer.id, name: customer.name },
    canApprove: z.boolean().parse(ok(adminRes, "権限")),
    items,
    suspectedDuplicates,
    masters,
    wallets,
  };
}

/** .in() に渡す ID が多いと URL が長くなりすぎるので、200 件ずつ分けて問い合わせる。各チャンクは fetchAll で全行を読むこと */
async function inChunks<T>(ids: readonly string[], fn: (chunk: string[]) => Promise<T[]>): Promise<T[][]> {
  const results: T[][] = [];
  for (let i = 0; i < ids.length; i += 200) results.push(await fn(ids.slice(i, i + 200)));
  return results;
}
