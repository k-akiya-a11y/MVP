import { partnerKey } from "../retrieval/normalize";
import { FreeeCallBudgetExceeded, type FreeeDeal, type FreeeMasters, type FreeeReadApi, type FreeeWalletTxn } from "./api";

/** マスタを同期する前に過去仕訳を取り込もうとした */
export class FreeeMastersNotSyncedError extends Error {
  constructor() {
    super("先にマスタを同期してください（取引先名から取引先キーを作るため）");
  }
}
/** 残りの呼出し回数では1か月分も取り込めず、この実行では1か月も進めなかった（成功扱いにしない） */
export class FreeeSyncStuckError extends Error {
  constructor(month: string) {
    super(
      `${month.slice(0, 7)} の1か月分の取込が、この実行の呼出しの上限に収まりませんでした。1か月も進めていません（上限の見直しか、月の分割が必要です）`,
    );
  }
}

/**
 * freee からの読み取り同期（設計書3章: マスタは1日1回、過去仕訳は初回に24か月分、以降は差分）。
 * ここは「freee の応答 → DB に書く行」への変換と、進め方の判定だけを行う。書込は FreeeSyncStore（DB の関数）が1回のトランザクションで行う。
 * freee への書込はしない。
 */

export type MasterRow = {
  kind: "account_item" | "partner" | "item" | "section" | "tag" | "tax";
  freee_id: number;
  name: string;
  available: boolean;
  attrs: Record<string, unknown>;
};

/** freee のマスタをマスタの写しの行にする。税区分は code を freee_id に入れる（既存の表と同じ） */
export function masterRows(m: FreeeMasters): MasterRow[] {
  return [
    ...m.accountItems.map((a) => ({
      kind: "account_item" as const,
      freee_id: a.id,
      name: a.name,
      available: a.available ?? true,
      attrs: typeof a.default_tax_code === "number" ? { default_tax_code: a.default_tax_code } : {},
    })),
    ...m.partners.map((p) => ({ kind: "partner" as const, freee_id: p.id, name: p.name, available: p.available ?? true, attrs: {} })),
    ...m.items.map((i) => ({ kind: "item" as const, freee_id: i.id, name: i.name, available: i.available ?? true, attrs: {} })),
    ...m.sections.map((s) => ({ kind: "section" as const, freee_id: s.id, name: s.name, available: s.available ?? true, attrs: {} })),
    ...m.tags.map((t) => ({ kind: "tag" as const, freee_id: t.id, name: t.name, available: true, attrs: {} })),
    ...m.taxes.map((t) => ({ kind: "tax" as const, freee_id: t.code, name: t.name_ja ?? t.name, available: t.available ?? true, attrs: {} })),
  ];
}

export type PastEntryRow = {
  freee_source_id: number;
  entry_date: string;
  amount: number;
  direction: "income" | "expense";
  bank_description: string | null;
  bank_description_source: "wallet_txn" | "partner_name" | "none";
  partner_key: string | null;
  partner_id: number | null;
  account_item_id: number;
  tax_code: number;
  item_id: number | null;
  section_id: number | null;
  tag_ids: number[];
  description: string | null;
};

export type PastEntryCounts = { deals: number; upserted: number; skipped_multi_line: number; skipped_non_positive: number; wallet_txn_matched: number };

const txnKey = (t: { walletable_type: string; walletable_id: number; date: string; amount: number; entry_side: string }) =>
  `${t.walletable_type}:${t.walletable_id}:${t.date}:${t.amount}:${t.entry_side}`;

/** 取引の決済に使った口座（1件だけのとき）。口座以外（プライベート資金など）や複数の決済は対象外 */
function singleWalletPayment(deal: FreeeDeal) {
  const payments = deal.payments ?? [];
  if (payments.length !== 1) return null;
  const p = payments[0]!;
  if (!p.from_walletable_id || !p.from_walletable_type || p.from_walletable_type === "private_account_item") return null;
  return { walletable_type: p.from_walletable_type, walletable_id: p.from_walletable_id, date: p.date, amount: p.amount };
}

/** 摘要を探すために口座明細を読む口座と期間（決済日の最小〜最大） */
export function walletWindows(deals: FreeeDeal[]) {
  const map = new Map<string, { type: FreeeWalletTxn["walletable_type"]; id: number; from: string; to: string }>();
  for (const d of deals) {
    const p = singleWalletPayment(d);
    if (!p) continue;
    const k = `${p.walletable_type}:${p.walletable_id}`;
    const w = map.get(k);
    if (!w) map.set(k, { type: p.walletable_type, id: p.walletable_id, from: p.date, to: p.date });
    else {
      if (p.date < w.from) w.from = p.date;
      if (p.date > w.to) w.to = p.date;
    }
  }
  return [...map.values()];
}

/**
 * 取引を過去仕訳の行にする。
 * - 明細行が1行の取引だけを取り込む（過去仕訳は取引1件につき1行で、科目が1つに決まらないものは代表例にできない）
 * - 銀行の摘要表記: 同じ口座・決済日・金額・入出金の口座明細が1件だけで、その明細に当たる取引も1件だけのとき、その摘要を使う
 *   （同日・同額が複数あるときは取り違えうるので使わない）。使えなければ取引先名から取引先キーを作る
 */
export function pastEntryRows(
  deals: FreeeDeal[],
  walletTxns: FreeeWalletTxn[],
  partnerNames: ReadonlyMap<number, string>,
): { rows: PastEntryRow[]; counts: PastEntryCounts } {
  const txnsByKey = new Map<string, FreeeWalletTxn[]>();
  for (const t of walletTxns) {
    const k = txnKey(t);
    txnsByKey.set(k, [...(txnsByKey.get(k) ?? []), t]);
  }
  const dealsByKey = new Map<string, number>();
  for (const d of deals) {
    const p = singleWalletPayment(d);
    if (p) {
      const k = txnKey({ ...p, entry_side: d.type });
      dealsByKey.set(k, (dealsByKey.get(k) ?? 0) + 1);
    }
  }

  const counts: PastEntryCounts = { deals: deals.length, upserted: 0, skipped_multi_line: 0, skipped_non_positive: 0, wallet_txn_matched: 0 };
  const rows: PastEntryRow[] = [];
  for (const d of deals) {
    if (d.details.length !== 1) {
      counts.skipped_multi_line++;
      continue;
    }
    if (d.amount <= 0) {
      counts.skipped_non_positive++;
      continue;
    }
    const line = d.details[0]!;
    const p = singleWalletPayment(d);
    const k = p ? txnKey({ ...p, entry_side: d.type }) : null;
    const candidates = k ? (txnsByKey.get(k) ?? []) : [];
    const matched = k && candidates.length === 1 && dealsByKey.get(k) === 1 ? candidates[0]! : null;
    const bankDescription = matched?.description?.trim() ? matched.description.trim() : null;
    const partnerName = d.partner_id ? partnerNames.get(d.partner_id) : undefined;
    let source: PastEntryRow["bank_description_source"] = "none";
    let key: string | null = null;
    if (bankDescription) {
      source = "wallet_txn";
      key = partnerKey(bankDescription);
      counts.wallet_txn_matched++;
    } else if (partnerName) {
      source = "partner_name";
      key = partnerKey(partnerName);
    }
    rows.push({
      freee_source_id: d.id,
      entry_date: d.issue_date,
      amount: d.amount,
      direction: d.type,
      bank_description: bankDescription,
      bank_description_source: source,
      partner_key: key,
      partner_id: d.partner_id ?? null,
      account_item_id: line.account_item_id,
      tax_code: line.tax_code,
      item_id: line.item_id ?? null,
      section_id: line.section_id ?? null,
      tag_ids: line.tag_ids ?? [],
      description: line.description ?? null,
    });
  }
  counts.upserted = rows.length;
  return { rows, counts };
}

// ---- 月単位の進め方 ----

/** 過去何か月分を取り込むか（設計書3章: 初回に過去24か月分） */
export const PAST_ENTRY_MONTHS = 24;
/** 初回の取込が終わった後、毎回読み直す直近の月数（freee 側の修正・追加を反映する差分取込） */
export const PAST_ENTRY_REFRESH_MONTHS = 2;

const pad = (n: number) => String(n).padStart(2, "0");
export const monthStart = (y: number, m: number) => {
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;
};
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return monthStart(y, m + n);
}
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 0));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export type PastEntryState = { from: string | null; until: string | null; nextMonth: string | null; completed: boolean };

/** 今回の範囲。初回は24か月前の月から今月まで。初回が終わっていれば、直近2か月から今月まで */
export function planPastEntryRange(state: PastEntryState, today: string): { from: string; until: string; nextMonth: string } {
  const thisMonth = `${today.slice(0, 7)}-01`;
  if (state.from && state.nextMonth && !state.completed) {
    return { from: state.from, until: state.until ?? thisMonth, nextMonth: state.nextMonth };
  }
  if (state.completed && state.from) {
    return { from: state.from, until: thisMonth, nextMonth: addMonths(thisMonth, -(PAST_ENTRY_REFRESH_MONTHS - 1)) };
  }
  const from = addMonths(thisMonth, -(PAST_ENTRY_MONTHS - 1));
  return { from, until: thisMonth, nextMonth: from };
}

export type FreeeSyncStore = {
  syncMasters(customerId: string, rows: MasterRow[]): Promise<{ upserted: number; madeUnavailable: number }>;
  loadPastEntryState(customerId: string): Promise<PastEntryState & { mastersSyncedAt: string | null }>;
  loadPartnerNames(customerId: string): Promise<Map<number, string>>;
  applyPastEntries(
    customerId: string,
    rows: PastEntryRow[],
    progress: { from: string; until: string; nextMonth: string; completed: boolean },
  ): Promise<number>;
};

export async function syncFreeeMasters(args: {
  customerId: string;
  companyId: number;
  accessToken: string;
  api: FreeeReadApi;
  store: FreeeSyncStore;
}) {
  const masters = await args.api.masters(args.accessToken, args.companyId);
  const rows = masterRows(masters);
  const result = await args.store.syncMasters(args.customerId, rows);
  const byKind: Record<string, number> = {};
  for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  return { ...byKind, upserted: result.upserted, unavailable: result.madeUnavailable };
}

/**
 * 過去仕訳を月単位で取り込む。1か月分（取引と、摘要を探す口座明細）を読み終えてから、その月の行と「次の月」を同じトランザクションで書く。
 * 呼出しの予算（api の CallCounter）を使い切ったら、その月は書かずに止める（次回、同じ月から続ける）。
 * 1か月も書けないまま予算が尽きたら、前に進めないので FreeeSyncStuckError にする（毎回同じ月を読み直して「完了」と返さない）。
 */
export async function syncFreeePastEntries(args: {
  customerId: string;
  companyId: number;
  accessToken: string;
  api: FreeeReadApi;
  store: FreeeSyncStore;
  today: string;
  maxMonths?: number;
}) {
  const state = await args.store.loadPastEntryState(args.customerId);
  if (!state.mastersSyncedAt) throw new FreeeMastersNotSyncedError();
  const partnerNames = await args.store.loadPartnerNames(args.customerId);
  const range = planPastEntryRange(state, args.today);
  const total: PastEntryCounts & { months: number } = {
    months: 0,
    deals: 0,
    upserted: 0,
    skipped_multi_line: 0,
    skipped_non_positive: 0,
    wallet_txn_matched: 0,
  };
  let month = range.nextMonth;
  const maxMonths = args.maxMonths ?? Number.POSITIVE_INFINITY;
  while (month <= range.until && total.months < maxMonths) {
    let deals: FreeeDeal[];
    const txns: FreeeWalletTxn[] = [];
    try {
      deals = await args.api.deals(args.accessToken, args.companyId, month, monthEnd(month));
      for (const w of walletWindows(deals)) {
        txns.push(...(await args.api.walletTxns(args.accessToken, args.companyId, { type: w.type, id: w.id }, w.from, w.to)));
      }
    } catch (error) {
      if (!(error instanceof FreeeCallBudgetExceeded)) throw error;
      if (total.months === 0) throw new FreeeSyncStuckError(month);
      // 書き終えた月までは保存済み。この月から次回続ける
      return { ...total, done: false, stoppedByCallLimit: true, nextMonth: month };
    }
    const { rows, counts } = pastEntryRows(deals, txns, partnerNames);
    const next = addMonths(month, 1);
    const completed = next > range.until;
    await args.store.applyPastEntries(args.customerId, rows, {
      from: range.from,
      until: range.until,
      // 終わったら、次回は直近の月を読み直す（planPastEntryRange が completed を見て決める）
      nextMonth: completed ? range.until : next,
      completed,
    });
    total.months++;
    for (const k of ["deals", "upserted", "skipped_multi_line", "skipped_non_positive", "wallet_txn_matched"] as const) total[k] += counts[k];
    month = next;
  }
  return { ...total, done: month > range.until, stoppedByCallLimit: false, nextMonth: month > range.until ? null : month };
}
