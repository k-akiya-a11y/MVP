import { z } from "zod";

/**
 * freee 会計 API の読み取り専用クライアント（設計書3章「読むのは自動、書くのは承認後だけ」）。
 *
 * - 持つのは GET だけ。取引の登録・証憑のアップロードなど freee に書き込む関数は、このファイルに置かない
 *   （書込は src/lib/execution が人の承認記録を確かめてから行う。未実装）
 * - 応答は zod で検証してから返す（外部 API の応答をそのまま信用しない）。金額・ID は安全な整数だけを受け付ける
 * - fetch を差し替えられるので、テストは偽の freee で行う（テストから本物の freee を呼ばない）
 * - アクセストークンは呼出しごとに受け取り、このモジュールには保存しない
 *
 * 応答の形は freee 会計 API の公式スキーマ（https://github.com/freee/freee-api-schema）に合わせた。
 * 本物の freee（テスト事業所）での確認は未実施。
 */

export const FREEE_API_BASE = "https://api.freee.co.jp";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** freee が 401 を返した（アクセストークンが無効・期限切れ） */
export class FreeeUnauthorizedError extends Error {}

/** freee がエラーを返した（401 以外）。本文は載せず、状態コードだけを持つ（本文に会社のデータが入りうるため） */
export class FreeeApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`freee API がエラーを返しました（${path}、HTTP ${status}）`);
  }
}

const id = z.number().int().positive().safe();
const yen = z.number().int().safe();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const companiesSchema = z.object({
  companies: z.array(z.object({ id, display_name: z.string().nullable().optional(), role: z.string().optional() })),
});
const accountItemsSchema = z.object({
  account_items: z.array(
    z.object({ id, name: z.string(), default_tax_code: z.number().int().nullable().optional(), available: z.boolean().optional() }),
  ),
});
const partnersSchema = z.object({ partners: z.array(z.object({ id, name: z.string(), available: z.boolean().optional() })) });
const itemsSchema = z.object({ items: z.array(z.object({ id, name: z.string(), available: z.boolean().optional() })) });
const sectionsSchema = z.object({ sections: z.array(z.object({ id, name: z.string(), available: z.boolean().optional() })) });
const tagsSchema = z.object({ tags: z.array(z.object({ id, name: z.string() })) });
const taxesSchema = z.object({
  taxes: z.array(
    z.object({
      code: z.number().int().nonnegative(),
      name: z.string(),
      name_ja: z.string().nullable().optional(),
      available: z.boolean().optional(),
    }),
  ),
});
const walletablesSchema = z.object({
  walletables: z.array(z.object({ id, name: z.string(), type: z.enum(["bank_account", "credit_card", "wallet"]) })),
});
const dealSchema = z.object({
  id,
  issue_date: date,
  type: z.enum(["income", "expense"]),
  amount: yen,
  partner_id: id.nullable().optional(),
  details: z.array(
    z.object({
      account_item_id: id,
      tax_code: z.number().int().nonnegative(),
      amount: yen,
      item_id: id.nullable().optional(),
      section_id: id.nullable().optional(),
      tag_ids: z.array(id).optional(),
      description: z.string().nullable().optional(),
    }),
  ),
  payments: z
    .array(
      z.object({
        date,
        from_walletable_type: z.enum(["bank_account", "credit_card", "wallet", "private_account_item"]).nullable().optional(),
        from_walletable_id: id.nullable().optional(),
        amount: yen,
      }),
    )
    .optional(),
});
const dealsSchema = z.object({ deals: z.array(dealSchema), meta: z.object({ total_count: z.number().int().nonnegative() }) });
const walletTxnSchema = z.object({
  id,
  date,
  amount: yen,
  entry_side: z.enum(["income", "expense"]),
  walletable_type: z.enum(["bank_account", "credit_card", "wallet"]),
  walletable_id: id,
  description: z.string().nullable().optional(),
});
const walletTxnsSchema = z.object({ wallet_txns: z.array(walletTxnSchema) });

export type FreeeDeal = z.infer<typeof dealSchema>;
export type FreeeWalletTxn = z.infer<typeof walletTxnSchema>;
export type FreeeMasters = {
  accountItems: z.infer<typeof accountItemsSchema>["account_items"];
  partners: z.infer<typeof partnersSchema>["partners"];
  items: z.infer<typeof itemsSchema>["items"];
  sections: z.infer<typeof sectionsSchema>["sections"];
  tags: z.infer<typeof tagsSchema>["tags"];
  taxes: z.infer<typeof taxesSchema>["taxes"];
};

/** 1回の取得の件数（freee の上限以下）。取引・口座明細は 100、取引先などは 3000 */
export const DEALS_PAGE_LIMIT = 100;
export const WALLET_TXNS_PAGE_LIMIT = 100;
export const MASTER_PAGE_LIMIT = 3000;

/** API 呼出しの回数を数える（1日の上限に対する予算。設計書3章「呼出し上限」） */
export type CallCounter = { calls: number; limit: number };

export class FreeeCallBudgetExceeded extends Error {
  constructor(limit: number) {
    super(`freee API の呼出しが、この実行の上限（${limit}回）に達しました`);
  }
}

export function freeeReadApi(opts: { fetch?: FetchLike; base?: string; counter: CallCounter }) {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = opts.base ?? FREEE_API_BASE;

  async function get<T>(accessToken: string, path: string, query: Record<string, string | number>, schema: z.ZodType<T>): Promise<T> {
    if (opts.counter.calls >= opts.counter.limit) throw new FreeeCallBudgetExceeded(opts.counter.limit);
    opts.counter.calls++;
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
    const res = await doFetch(`${base}${path}${qs ? `?${qs}` : ""}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "X-Api-Version": "2020-06-15" },
    });
    if (res.status === 401) throw new FreeeUnauthorizedError("freee のアクセストークンが無効です");
    if (!res.ok) throw new FreeeApiError(path, res.status);
    return schema.parse(await res.json());
  }

  /** offset/limit で全件を読む（取引先・品目・部門・メモタグ） */
  async function getAllPages<S, T>(
    accessToken: string,
    path: string,
    query: Record<string, string | number>,
    schema: z.ZodType<S>,
    pick: (s: S) => T[],
    limit: number,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; ; offset += limit) {
      const page = pick(await get(accessToken, path, { ...query, offset, limit }, schema));
      out.push(...page);
      if (page.length < limit) return out;
    }
  }

  return {
    /** 認可したユーザーが参加している事業所 */
    async companies(accessToken: string) {
      return (await get(accessToken, "/api/1/companies", {}, companiesSchema)).companies;
    },

    async masters(accessToken: string, companyId: number): Promise<FreeeMasters> {
      const q = { company_id: companyId };
      const accountItems = (await get(accessToken, "/api/1/account_items", q, accountItemsSchema)).account_items;
      const partners = await getAllPages(accessToken, "/api/1/partners", q, partnersSchema, (s) => s.partners, MASTER_PAGE_LIMIT);
      const items = await getAllPages(accessToken, "/api/1/items", q, itemsSchema, (s) => s.items, MASTER_PAGE_LIMIT);
      const sections = (await get(accessToken, "/api/1/sections", q, sectionsSchema)).sections;
      const tags = await getAllPages(accessToken, "/api/1/tags", q, tagsSchema, (s) => s.tags, MASTER_PAGE_LIMIT);
      const taxes = (await get(accessToken, `/api/1/taxes/companies/${companyId}`, {}, taxesSchema)).taxes;
      return { accountItems, partners, items, sections, tags, taxes };
    },

    async walletables(accessToken: string, companyId: number) {
      return (await get(accessToken, "/api/1/walletables", { company_id: companyId }, walletablesSchema)).walletables;
    },

    /** 発生日が from〜to（両端を含む）の取引を全件 */
    async deals(accessToken: string, companyId: number, from: string, to: string): Promise<FreeeDeal[]> {
      const out: FreeeDeal[] = [];
      for (let offset = 0; ; offset += DEALS_PAGE_LIMIT) {
        const page = await get(
          accessToken,
          "/api/1/deals",
          { company_id: companyId, start_issue_date: from, end_issue_date: to, offset, limit: DEALS_PAGE_LIMIT },
          dealsSchema,
        );
        out.push(...page.deals);
        if (page.deals.length < DEALS_PAGE_LIMIT || out.length >= page.meta.total_count) return out;
      }
    },

    /** 口座の明細（日付が from〜to）を全件 */
    async walletTxns(
      accessToken: string,
      companyId: number,
      walletable: { type: FreeeWalletTxn["walletable_type"]; id: number },
      from: string,
      to: string,
    ): Promise<FreeeWalletTxn[]> {
      const out: FreeeWalletTxn[] = [];
      for (let offset = 0; ; offset += WALLET_TXNS_PAGE_LIMIT) {
        const page = await get(
          accessToken,
          "/api/1/wallet_txns",
          {
            company_id: companyId,
            walletable_type: walletable.type,
            walletable_id: walletable.id,
            start_date: from,
            end_date: to,
            offset,
            limit: WALLET_TXNS_PAGE_LIMIT,
          },
          walletTxnsSchema,
        );
        out.push(...page.wallet_txns);
        if (page.wallet_txns.length < WALLET_TXNS_PAGE_LIMIT) return out;
      }
    },
  };
}

export type FreeeReadApi = ReturnType<typeof freeeReadApi>;
