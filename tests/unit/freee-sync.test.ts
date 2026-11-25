import { describe, expect, it, vi } from "vitest";
import { freeeReadApi, type FreeeDeal, type FreeeWalletTxn } from "@/lib/freee/api";
import {
  masterRows,
  monthEnd,
  pastEntryRows,
  planPastEntryRange,
  syncFreeePastEntries,
  type FreeeSyncStore,
  type PastEntryRow,
} from "@/lib/freee/sync";
import { fakeFreee, page } from "../fixtures/fake-freee";

// データはすべて架空
const BANK = { from_walletable_type: "bank_account" as const, from_walletable_id: 7 };
function deal(id: number, over: Partial<FreeeDeal> = {}): FreeeDeal {
  return {
    id,
    issue_date: "2026-10-01",
    type: "expense",
    amount: 165000,
    partner_id: 311,
    details: [{ account_item_id: 105, tax_code: 21, amount: 165000, item_id: null, section_id: 401, tag_ids: [501], description: "10月分 家賃" }],
    payments: [{ date: "2026-10-01", ...BANK, amount: 165000 }],
    ...over,
  };
}
function txn(id: number, over: Partial<FreeeWalletTxn> = {}): FreeeWalletTxn {
  return {
    id,
    date: "2026-10-01",
    amount: 165000,
    entry_side: "expense",
    walletable_type: "bank_account",
    walletable_id: 7,
    description: "ｶ)ｹﾝｼｮｳﾌﾄﾞｳｻﾝ",
    ...over,
  };
}
const partnerNames = new Map([[311, "株式会社検証不動産"]]);

describe("マスタの写し", () => {
  it("種類ごとに行にし、税区分は code、科目の既定税区分は attrs に入れる", () => {
    const rows = masterRows({
      accountItems: [{ id: 105, name: "地代家賃", default_tax_code: 21, available: true }],
      partners: [{ id: 311, name: "株式会社検証不動産", available: false }],
      items: [],
      sections: [{ id: 401, name: "本社" }],
      tags: [{ id: 501, name: "家賃" }],
      taxes: [{ code: 21, name: "purchase_with_tax_10", name_ja: "課対仕入10%" }],
    });
    expect(rows).toEqual([
      { kind: "account_item", freee_id: 105, name: "地代家賃", available: true, attrs: { default_tax_code: 21 } },
      { kind: "partner", freee_id: 311, name: "株式会社検証不動産", available: false, attrs: {} },
      { kind: "section", freee_id: 401, name: "本社", available: true, attrs: {} },
      { kind: "tag", freee_id: 501, name: "家賃", available: true, attrs: {} },
      { kind: "tax", freee_id: 21, name: "課対仕入10%", available: true, attrs: {} },
    ]);
  });
});

describe("取引 → 過去仕訳", () => {
  it("口座・日付・金額・入出金が一致する口座明細が1件だけなら、その摘要から取引先キーを作る", () => {
    const { rows, counts } = pastEntryRows([deal(1)], [txn(10)], partnerNames);
    expect(rows[0]).toMatchObject({
      freee_source_id: 1,
      bank_description: "ｶ)ｹﾝｼｮｳﾌﾄﾞｳｻﾝ",
      bank_description_source: "wallet_txn",
      partner_key: "ケンシヨウフドウサン",
      account_item_id: 105,
      tag_ids: [501],
    });
    expect(counts.wallet_txn_matched).toBe(1);
  });

  it("同日・同額の取引が2件あれば、どちらの摘要か決められないので取引先名から作る（取り違えない）", () => {
    const { rows } = pastEntryRows([deal(1), deal(2)], [txn(10), txn(11, { description: "ﾍﾞﾂﾉﾋﾄ" })], partnerNames);
    expect(rows.map((r) => r.bank_description_source)).toEqual(["partner_name", "partner_name"]);
    expect(rows.every((r) => r.bank_description === null)).toBe(true);
  });

  it("同日・同額の口座明細が2件あっても、取り違えうるので使わない", () => {
    const { rows } = pastEntryRows([deal(1)], [txn(10), txn(11)], partnerNames);
    expect(rows[0]!.bank_description_source).toBe("partner_name");
  });

  it("入出金が逆の口座明細には当てない。取引先もなければ none", () => {
    const { rows } = pastEntryRows([deal(1, { partner_id: null })], [txn(10, { entry_side: "income" })], partnerNames);
    expect(rows[0]).toMatchObject({ bank_description: null, bank_description_source: "none", partner_key: null });
  });

  it("明細行が複数の取引は取り込まず、数を残す（黙って落とさない）", () => {
    const multi = deal(1, {
      details: [
        { account_item_id: 105, tax_code: 21, amount: 100000 },
        { account_item_id: 106, tax_code: 21, amount: 65000 },
      ],
    });
    const { rows, counts } = pastEntryRows([multi, deal(2)], [], partnerNames);
    expect(rows.map((r) => r.freee_source_id)).toEqual([2]);
    expect(counts).toMatchObject({ deals: 2, upserted: 1, skipped_multi_line: 1 });
  });
});

describe("過去仕訳の取込範囲（24か月 → 以降は直近2か月）", () => {
  it("初回は24か月前の月から今月まで", () => {
    expect(planPastEntryRange({ from: null, until: null, nextMonth: null, completed: false }, "2026-11-25")).toEqual({
      from: "2024-12-01",
      until: "2026-11-01",
      nextMonth: "2024-12-01",
    });
  });
  it("途中なら続きの月から", () => {
    expect(
      planPastEntryRange({ from: "2024-12-01", until: "2026-11-01", nextMonth: "2025-06-01", completed: false }, "2026-11-30"),
    ).toEqual({ from: "2024-12-01", until: "2026-11-01", nextMonth: "2025-06-01" });
  });
  it("初回が終わっていれば、直近2か月から今月まで読み直す", () => {
    expect(
      planPastEntryRange({ from: "2024-12-01", until: "2026-11-01", nextMonth: "2026-11-01", completed: true }, "2027-01-10"),
    ).toEqual({ from: "2024-12-01", until: "2027-01-01", nextMonth: "2026-12-01" });
  });
  it("月末日", () => {
    expect(monthEnd("2028-02-01")).toBe("2028-02-29");
    expect(monthEnd("2026-12-01")).toBe("2026-12-31");
  });
});

describe("過去仕訳の取込（月ごとに書き、進み具合を一緒に保存する）", () => {
  function memoryStore(init: { from?: string; nextMonth?: string; until?: string; completed?: boolean } = {}) {
    const state = { from: init.from ?? null, until: init.until ?? null, nextMonth: init.nextMonth ?? null, completed: init.completed ?? false };
    const written: { rows: PastEntryRow[]; progress: unknown }[] = [];
    const store: FreeeSyncStore = {
      syncMasters: vi.fn(),
      loadPastEntryState: async () => ({ ...state, mastersSyncedAt: "2026-11-25T00:00:00Z" }),
      loadPartnerNames: async () => partnerNames,
      applyPastEntries: async (_c, rows, progress) => {
        written.push({ rows, progress });
        Object.assign(state, { from: progress.from, until: progress.until, nextMonth: progress.nextMonth, completed: progress.completed });
        return rows.length;
      },
    };
    return { state, written, store };
  }
  function freee(dealsByMonth: Record<string, FreeeDeal[]>) {
    return fakeFreee({
      "/api/1/deals": (url) => ({
        body: { deals: page(url, dealsByMonth[url.searchParams.get("start_issue_date")!] ?? []), meta: { total_count: 0 } },
      }),
      "/api/1/wallet_txns": () => ({ body: { wallet_txns: [txn(10)] } }),
    });
  }

  it("月を順に読み、各月の行と次の月を保存する。最後の月で完了にする", async () => {
    const m = memoryStore({ from: "2026-09-01", until: "2026-10-01", nextMonth: "2026-09-01" });
    const f = freee({ "2026-10-01": [deal(1)] });
    const api = freeeReadApi({ fetch: f.fetch, counter: { calls: 0, limit: 100 } });
    const r = await syncFreeePastEntries({ customerId: "c", companyId: 900001, accessToken: "t", api, store: m.store, today: "2026-10-20" });
    expect(r).toMatchObject({ months: 2, upserted: 1, done: true });
    expect(m.written.map((w) => w.progress)).toEqual([
      { from: "2026-09-01", until: "2026-10-01", nextMonth: "2026-10-01", completed: false },
      { from: "2026-09-01", until: "2026-10-01", nextMonth: "2026-10-01", completed: true },
    ]);
    expect(m.written[1]!.rows[0]!.bank_description_source).toBe("wallet_txn");
  });

  it("呼出しの予算が月の途中で尽きたら、その月は書かず、書き終えた月までを残す（次回はその月から）", async () => {
    const m = memoryStore({ from: "2026-08-01", until: "2026-10-01", nextMonth: "2026-08-01" });
    const f = freee({ "2026-08-01": [deal(1)], "2026-09-01": [deal(2, { issue_date: "2026-09-01" })] });
    // 8月: 取引1 + 口座明細1 = 2回。9月の取引で3回目、口座明細の4回目で上限
    const api = freeeReadApi({ fetch: f.fetch, counter: { calls: 0, limit: 3 } });
    await expect(
      syncFreeePastEntries({ customerId: "c", companyId: 900001, accessToken: "t", api, store: m.store, today: "2026-10-20" }),
    ).rejects.toThrow("上限");
    expect(m.written).toHaveLength(1);
    expect(m.state.nextMonth).toBe("2026-09-01");
  });

  it("マスタを同期する前は取り込まない（取引先名から取引先キーを作れないため）", async () => {
    const m = memoryStore();
    m.store.loadPastEntryState = async () => ({ from: null, until: null, nextMonth: null, completed: false, mastersSyncedAt: null });
    const api = freeeReadApi({ fetch: freee({}).fetch, counter: { calls: 0, limit: 10 } });
    await expect(
      syncFreeePastEntries({ customerId: "c", companyId: 1, accessToken: "t", api, store: m.store, today: "2026-10-20" }),
    ).rejects.toThrow("先にマスタ");
  });
});
