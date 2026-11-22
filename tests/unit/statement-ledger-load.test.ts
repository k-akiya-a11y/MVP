import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  LEDGER_MAX_PAGE,
  LEDGER_PAGE_SIZE,
  NO_FILTERS,
  TXN_STATUSES,
  TXN_STATUS_LABEL,
  WALLET_OPTION_LIMIT,
  loadLedger,
  type LedgerFilters,
} from "@/lib/statements/ledger";

const CID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const W1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const IMP = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

type Row = Record<string, unknown>;
type Call = {
  table: string;
  select: string;
  eq: [string, unknown][];
  in: [string, unknown[]][];
  gte: [string, string][];
  lte: [string, string][];
  order: [string, boolean][];
  range?: [number, number];
};
type Opts = {
  tables?: Record<string, Row[]>;
  customer?: { data: unknown; error: { message: string } | null };
  /** 1回の応答で返す最大行数（PostgREST の max-rows の模擬） */
  cap?: number;
  errors?: Record<string, { message: string }>;
  /** 表ごとに応答の data を差し替える（形式不正・絞り込みをすり抜けた混入の検証用） */
  data?: Record<string, unknown>;
};

/** eq / in / order / range を実際に適用する最小のメモリ上のクライアント。実 DB・RLS は通らない */
function fake(opts: Opts) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, select: "", eq: [], in: [], gte: [], lte: [], order: [] };
      calls.push(call);
      const orders: { col: string; asc: boolean }[] = [];
      let range: [number, number] | undefined;
      const run = () => {
        if (opts.errors?.[table]) return { data: null, error: opts.errors[table] };
        if (opts.data && table in opts.data) return { data: opts.data[table], error: null };
        let rows = [...(opts.tables?.[table] ?? [])];
        for (const [c, v] of call.eq) rows = rows.filter((r) => r[c] === v);
        for (const [c, v] of call.gte) rows = rows.filter((r) => String(r[c]) >= v);
        for (const [c, v] of call.lte) rows = rows.filter((r) => String(r[c]) <= v);
        for (const [c, vs] of call.in) rows = rows.filter((r) => vs.includes(r[c]));
        for (const o of [...orders].reverse()) {
          rows.sort((a, b) => {
            const x = String(a[o.col]);
            const y = String(b[o.col]);
            return (x < y ? -1 : x > y ? 1 : 0) * (o.asc ? 1 : -1);
          });
        }
        if (range) rows = rows.slice(range[0], range[1] + 1);
        if (opts.cap !== undefined) rows = rows.slice(0, opts.cap);
        return { data: rows, error: null };
      };
      const q = {
        select: (s: string) => ((call.select = s), q),
        eq: (c: string, v: unknown) => (call.eq.push([c, v]), q),
        in: (c: string, v: unknown[]) => (call.in.push([c, v]), q),
        gte: (c: string, v: string) => (call.gte.push([c, v]), q),
        lte: (c: string, v: string) => (call.lte.push([c, v]), q),
        order: (col: string, o?: { ascending?: boolean }) => (
          orders.push({ col, asc: o?.ascending ?? true }), call.order.push([col, o?.ascending ?? true]), q
        ),
        range: (from: number, to: number) => ((range = [from, to]), (call.range = range), q),
        maybeSingle: async () => opts.customer ?? { data: { id: CID, name: "テスト商事" }, error: null },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const tid = (n: number) => `t-${String(n).padStart(4, "0")}`;
const txn = (n: number, o: Row = {}): Row => ({
  id: tid(n),
  customer_id: CID,
  wallet_id: W1,
  import_id: IMP,
  txn_date: "2026-10-03",
  amount: 3000,
  direction: "expense",
  description: "ＡＢＣ商店",
  status: "new",
  duplicate_of_id: null,
  ...o,
});
const wallet = (o: Row = {}): Row => ({ id: W1, customer_id: CID, name: "普通預金", ...o });
const tables = (txns: Row[], wallets: Row[] = [wallet()]) => ({ bank_transactions: txns, wallets });

describe("明細一覧の読込", () => {
  it("UUID でない顧客IDは何も読まずに null", async () => {
    const { client, calls } = fake({});
    expect(await loadLedger(client, "not-a-uuid", 1)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("顧客が見えない（RLS で null）ときは null で、明細も口座も読まない", async () => {
    const { client, calls } = fake({ customer: { data: null, error: null }, tables: tables([txn(1)]) });
    expect(await loadLedger(client, CID, 1)).toBeNull();
    expect(calls.map((c) => c.table)).toEqual(["customers"]);
  });

  it("顧客の読込エラー・undefined・別IDの顧客は例外（null=404 にしない）", async () => {
    await expect(loadLedger(fake({ customer: { data: null, error: { message: "boom" } } }).client, CID, 1)).rejects.toThrow();
    await expect(loadLedger(fake({ customer: { data: undefined, error: null } }).client, CID, 1)).rejects.toThrow();
    await expect(loadLedger(fake({ customer: { data: { id: OTHER, name: "他社" }, error: null } }).client, CID, 1)).rejects.toThrow("一致しません");
  });

  it("不正なページ番号は例外", async () => {
    for (const p of [0, -1, 1.5, NaN, LEDGER_MAX_PAGE + 1]) {
      await expect(loadLedger(fake({}).client, CID, p)).rejects.toThrow("ページ番号");
    }
  });

  it("未判定・承認済み・重複など全ての状態を読み、日本語の表示名がある", async () => {
    const statuses = TXN_STATUSES.map((s, i) => txn(i + 1, { status: s, duplicate_of_id: s === "duplicate_suspected" ? tid(99) : null }));
    const r = await loadLedger(fake({ tables: tables(statuses) }).client, CID, 1);
    expect(r?.rows.map((x) => x.status).sort()).toEqual([...TXN_STATUSES].sort());
    for (const s of TXN_STATUSES) expect(TXN_STATUS_LABEL[s]).toMatch(/[ぁ-んァ-ン一-龥]/);
    expect(TXN_STATUS_LABEL.approved).not.toBe(TXN_STATUS_LABEL.registered);
    expect(r?.rows.find((x) => x.status === "duplicate_suspected")?.duplicateOfId).toBe(tid(99));
  });

  it("明細は customer_id で絞り、txn_date 降順・id 降順を明示して読む。口座も顧客で絞る", async () => {
    const { client, calls } = fake({
      tables: tables([txn(1, { txn_date: "2026-10-01" }), txn(2, { txn_date: "2026-10-03" }), txn(3, { txn_date: "2026-10-03" }), txn(4, { customer_id: OTHER })]),
    });
    const r = await loadLedger(client, CID, 1);
    expect(r?.rows.map((x) => x.id)).toEqual([tid(3), tid(2), tid(1)]);
    const t = calls.find((c) => c.table === "bank_transactions")!;
    expect(t.eq).toContainEqual(["customer_id", CID]);
    expect(t.order).toEqual([
      ["txn_date", false],
      ["id", false],
    ]);
    const w = calls.find((c) => c.table === "wallets")!;
    expect(w.eq).toContainEqual(["customer_id", CID]);
  });

  it("口座名は顧客内のものだけ。他顧客の口座の名前は使わず、読めない口座は name null で行は残す", async () => {
    const { client } = fake({
      tables: tables([txn(1), txn(2, { wallet_id: WO })], [wallet(), wallet({ id: WO, customer_id: OTHER, name: "他社の口座" })]),
    });
    const r = await loadLedger(client, CID, 1);
    expect(r?.rows.find((x) => x.id === tid(1))?.wallet).toEqual({ id: W1, name: "普通預金" });
    expect(r?.rows.find((x) => x.id === tid(2))?.wallet).toEqual({ id: WO, name: null });
  });

  it("他の顧客の明細・口座が混入したら例外", async () => {
    await expect(loadLedger(fake({ data: { bank_transactions: [txn(1, { customer_id: OTHER })] } }).client, CID, 1)).rejects.toThrow("他の顧客");
    await expect(loadLedger(fake({ tables: tables([txn(1)]), data: { wallets: [wallet({ customer_id: OTHER })] } }).client, CID, 1)).rejects.toThrow("他の顧客");
  });

  it("読込エラー・応答の形式不正・ID重複は例外で、空の結果にしない", async () => {
    await expect(loadLedger(fake({ errors: { bank_transactions: { message: "x" } } }).client, CID, 1)).rejects.toThrow("明細の読込に失敗");
    await expect(loadLedger(fake({ tables: tables([txn(1)]), errors: { wallets: { message: "x" } } }).client, CID, 1)).rejects.toThrow("口座の読込に失敗");
    await expect(loadLedger(fake({ data: { bank_transactions: { not: "array" } } }).client, CID, 1)).rejects.toThrow("形式が不正");
    await expect(loadLedger(fake({ data: { bank_transactions: [txn(1), txn(1)] } }).client, CID, 1)).rejects.toThrow("重複");
  });

  it("未知の状態・不正な日付・入出金は例外（推測して表示しない）", async () => {
    for (const bad of [{ status: "mystery" }, { txn_date: "2026/10/03" }, { txn_date: null }, { direction: "transfer" }, { description: null }]) {
      await expect(loadLedger(fake({ data: { bank_transactions: [txn(1, bad)] } }).client, CID, 1)).rejects.toThrow();
    }
  });

  it("安全でない金額（0・負・小数・桁あふれ・非数字の文字列）は例外。bigint の数字文字列は受け付ける", async () => {
    for (const a of [0, -5, 1.5, Number.MAX_SAFE_INTEGER + 1, "9007199254740993", "12abc", "-3", null, ""]) {
      await expect(loadLedger(fake({ data: { bank_transactions: [txn(1, { amount: a })] } }).client, CID, 1)).rejects.toThrow();
    }
    const r = await loadLedger(fake({ tables: tables([txn(1, { amount: "9007199254740991" })]) }).client, CID, 1);
    expect(r?.rows[0]?.amount).toBe(9007199254740991);
  });

  it("50件ちょうどなら次なし、51件目があれば次あり（51件目は返さない）", async () => {
    const fifty = Array.from({ length: LEDGER_PAGE_SIZE }, (_, i) => txn(i + 1));
    let r = await loadLedger(fake({ tables: tables(fifty) }).client, CID, 1);
    expect(r?.rows).toHaveLength(LEDGER_PAGE_SIZE);
    expect(r?.hasNext).toBe(false);
    r = await loadLedger(fake({ tables: tables([...fifty, txn(51)]) }).client, CID, 1);
    expect(r?.rows).toHaveLength(LEDGER_PAGE_SIZE);
    expect(r?.hasNext).toBe(true);
    expect(r?.hasPrevious).toBe(false);
  });

  it("2ページ目は 50 件目の次から読み、前へがある。範囲外のページは 0 件の結果（エラーではない）", async () => {
    const all = Array.from({ length: 60 }, (_, i) => txn(i + 1));
    const { client, calls } = fake({ tables: tables(all) });
    const r = await loadLedger(client, CID, 2);
    expect(r?.rows).toHaveLength(10);
    expect(r?.hasPrevious).toBe(true);
    expect(r?.hasNext).toBe(false);
    expect(calls.find((c) => c.table === "bank_transactions")!.range).toEqual([50, 100]);
    const empty = await loadLedger(fake({ tables: tables(all) }).client, CID, 5);
    expect(empty?.rows).toEqual([]);
  });

  it("サーバーの1回の上限（cap）で切れても、続けて読んで1ページ分と次ページの有無を正しく返す", async () => {
    const all = Array.from({ length: 120 }, (_, i) => txn(i + 1));
    const { client, calls } = fake({ tables: tables(all), cap: 20 });
    const r = await loadLedger(client, CID, 1);
    expect(r?.rows).toHaveLength(LEDGER_PAGE_SIZE);
    expect(r?.hasNext).toBe(true);
    expect(calls.filter((c) => c.table === "bank_transactions").length).toBeGreaterThan(1);
    // 順序が崩れず重複もない
    expect(r?.rows.map((x) => x.id)).toEqual(all.map((x) => x.id as string).reverse().slice(0, LEDGER_PAGE_SIZE));
    const last = await loadLedger(fake({ tables: tables(all), cap: 20 }).client, CID, 3);
    expect(last?.rows).toHaveLength(20);
    expect(last?.hasNext).toBe(false);
  });

  it("表示できる最終ページでは hasNext を false にし、より古い明細があれば olderBeyondLimit", async () => {
    const rows = Array.from({ length: LEDGER_PAGE_SIZE + 1 }, (_, i) => txn(i + 1));
    const { client } = fake({ data: { bank_transactions: rows } });
    const r = await loadLedger(client, CID, LEDGER_MAX_PAGE);
    expect(r?.hasNext).toBe(false);
    expect(r?.olderBeyondLimit).toBe(true);
    expect(r?.rows).toHaveLength(LEDGER_PAGE_SIZE);
  });
});

describe("明細一覧の絞り込み（SQL 側・ページ分割より前）", () => {
  const W2 = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const f = (o: Partial<LedgerFilters>): LedgerFilters => ({ ...NO_FILTERS, ...o });
  const day = (n: number) => `2026-10-${String((n % 28) + 1).padStart(2, "0")}`;
  const two = [wallet(), wallet({ id: W2, name: "カード" })];
  const sorted = (rows: Row[]) =>
    [...rows]
      .sort((a, b) => {
        const [ad, bd, ai, bi] = [String(a.txn_date), String(b.txn_date), String(a.id), String(b.id)];
        return ad === bd ? (ai < bi ? 1 : -1) : ad < bd ? 1 : -1;
      })
      .map((r) => String(r.id));

  it("状態・口座・日付の複合条件を、並び・範囲より前に付けて読み、ページ 1 と 2 が条件に合う全体の連続した区間になる", async () => {
    const all = Array.from({ length: 400 }, (_, i) =>
      txn(i + 1, { status: (i + 1) % 2 === 0 ? "new" : "approved", wallet_id: i + 1 <= 300 ? W1 : W2, txn_date: day(i + 1) }),
    );
    const flt = f({ status: "new", walletId: W1, from: "2026-10-05", to: "2026-10-20" });
    const expected = sorted(all.filter((r) => r.status === "new" && r.wallet_id === W1 && String(r.txn_date) >= "2026-10-05" && String(r.txn_date) <= "2026-10-20"));
    expect(expected.length).toBeGreaterThan(LEDGER_PAGE_SIZE);
    const { client, calls } = fake({ tables: tables(all, two) });
    const p1 = await loadLedger(client, CID, 1, flt);
    const p2 = await loadLedger(fake({ tables: tables(all, two) }).client, CID, 2, flt);
    expect(p1?.rows.map((x) => x.id)).toEqual(expected.slice(0, LEDGER_PAGE_SIZE));
    expect(p2?.rows.map((x) => x.id)).toEqual(expected.slice(LEDGER_PAGE_SIZE, LEDGER_PAGE_SIZE * 2));
    expect(p1?.hasNext).toBe(true);
    expect(p2?.hasNext).toBe(expected.length > LEDGER_PAGE_SIZE * 2);
    expect(p1?.filters).toEqual(flt);
    const t = calls.find((c) => c.table === "bank_transactions")!;
    expect(t.eq).toEqual(expect.arrayContaining([["customer_id", CID], ["status", "new"], ["wallet_id", W1]]));
    expect(t.gte).toEqual([["txn_date", "2026-10-05"]]);
    expect(t.lte).toEqual([["txn_date", "2026-10-20"]]);
    expect(t.range).toEqual([0, LEDGER_PAGE_SIZE]);
  });

  it("開始日・終了日は両端を含む。片方だけの指定も効く", async () => {
    const rows = [txn(1, { txn_date: "2026-09-30" }), txn(2, { txn_date: "2026-10-01" }), txn(3, { txn_date: "2026-10-31" }), txn(4, { txn_date: "2026-11-01" })];
    const ids = async (x: LedgerFilters) => (await loadLedger(fake({ tables: tables(rows) }).client, CID, 1, x))?.rows.map((r) => r.id);
    expect(await ids(f({ from: "2026-10-01", to: "2026-10-31" }))).toEqual([tid(3), tid(2)]);
    expect(await ids(f({ from: "2026-10-31" }))).toEqual([tid(4), tid(3)]);
    expect(await ids(f({ to: "2026-10-01" }))).toEqual([tid(2), tid(1)]);
    expect(await ids(f({ from: "2026-10-05", to: "2026-10-05" }))).toEqual([]);
  });

  it("絞り込み 0 件はエラーではなく空の結果で、絞り込みを保持して返す", async () => {
    const r = await loadLedger(fake({ tables: tables([txn(1)]) }).client, CID, 1, f({ status: "rejected" }));
    expect(r?.rows).toEqual([]);
    expect(r?.walletUnavailable).toBe(false);
    expect(r?.filters.status).toBe("rejected");
  });

  it("サーバーの1回の上限（cap）で切れても、続けて読む全ての呼出が同じ顧客・絞り込み・並びを持つ", async () => {
    const all = Array.from({ length: 120 }, (_, i) => txn(i + 1, { status: "new" }));
    const other = Array.from({ length: 30 }, (_, i) => txn(i + 200, { status: "approved" }));
    const flt = f({ status: "new", from: "2026-10-01", to: "2026-10-31" });
    const { client, calls } = fake({ tables: tables([...all, ...other]), cap: 20 });
    const r = await loadLedger(client, CID, 1, flt);
    const reads = calls.filter((c) => c.table === "bank_transactions");
    expect(reads.length).toBeGreaterThan(1);
    for (const c of reads) {
      expect(c.eq).toEqual([["customer_id", CID], ["status", "new"]]);
      expect(c.gte).toEqual([["txn_date", "2026-10-01"]]);
      expect(c.lte).toEqual([["txn_date", "2026-10-31"]]);
      expect(c.order).toEqual([["txn_date", false], ["id", false]]);
    }
    expect(r?.rows).toHaveLength(LEDGER_PAGE_SIZE);
    expect(r?.rows.every((x) => x.status === "new")).toBe(true);
    expect(r?.hasNext).toBe(true);
  });

  it("同じ日・同じ条件の明細は id 降順で安定し、ページをまたいで重複も欠落もない", async () => {
    const all = Array.from({ length: 70 }, (_, i) => txn(i + 1, { status: "new", txn_date: "2026-10-10" }));
    const flt = f({ status: "new" });
    const a = await loadLedger(fake({ tables: tables(all) }).client, CID, 1, flt);
    const b = await loadLedger(fake({ tables: tables(all), cap: 7 }).client, CID, 2, flt);
    const joined = [...(a?.rows ?? []), ...(b?.rows ?? [])].map((x) => x.id);
    expect(joined).toEqual(all.map((x) => x.id as string).reverse());
  });

  it("口座の選択肢は顧客で絞って名前順に読み、他顧客の口座は含めない", async () => {
    const { client, calls } = fake({ tables: tables([], [wallet({ id: W2, name: "カード" }), wallet(), wallet({ id: WO, customer_id: OTHER, name: "他社の口座" })]) });
    const r = await loadLedger(client, CID, 1);
    expect(r?.walletOptions.map((w) => w.name)).toEqual(["カード", "普通預金"].sort());
    expect(JSON.stringify(r)).not.toContain("他社の口座");
    const w = calls.find((c) => c.table === "wallets")!;
    expect(w.eq).toContainEqual(["customer_id", CID]);
    expect(w.order).toEqual([["name", true], ["id", true]]);
  });

  it("口座が多く API の応答上限で切れても上限件数まで続けて読み、超えたら一部のみと示す。選択肢外の自顧客の口座も確認して絞れる", async () => {
    const wid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const ws = Array.from({ length: WALLET_OPTION_LIMIT + 30 }, (_, i) => wallet({ id: wid(i + 1), name: `口座${String(i + 1).padStart(4, "0")}` }));
    const target = wid(WALLET_OPTION_LIMIT + 25);
    const { client, calls } = fake({ tables: tables([txn(1, { wallet_id: target })], ws), cap: 50 });
    const r = await loadLedger(client, CID, 1, f({ walletId: target }));
    expect(r?.walletOptions.length).toBeGreaterThanOrEqual(WALLET_OPTION_LIMIT);
    expect(r?.walletOptionsTruncated).toBe(true);
    expect(calls.filter((c) => c.table === "wallets" && c.range).length).toBeGreaterThan(1);
    expect(r?.walletUnavailable).toBe(false);
    expect(r?.rows.map((x) => x.id)).toEqual([tid(1)]);
    expect(r?.walletOptions.some((w) => w.id === target)).toBe(true);
    // 選択肢外で、顧客にも存在しない口座は確認できず、明細を読まない
    const none = fake({ tables: tables([txn(1)], ws), cap: 50 });
    const r2 = await loadLedger(none.client, CID, 1, f({ walletId: wid(9999) }));
    expect(r2?.walletUnavailable).toBe(true);
    expect(none.calls.some((c) => c.table === "bank_transactions")).toBe(false);
  });

  it("他の顧客の口座・存在しない口座の ID を指定しても、明細を読まず、条件を広げず、名前も返さない（区別もしない）", async () => {
    const ws = [wallet(), wallet({ id: WO, customer_id: OTHER, name: "他社の口座" })];
    for (const id of [WO, "99999999-9999-4999-8999-999999999999"]) {
      const { client, calls } = fake({ tables: tables([txn(1), txn(2, { wallet_id: WO, customer_id: OTHER })], ws) });
      const r = await loadLedger(client, CID, 1, f({ walletId: id }));
      expect(r?.walletUnavailable).toBe(true);
      expect(r?.rows).toEqual([]);
      expect(calls.some((c) => c.table === "bank_transactions")).toBe(false);
      expect(JSON.stringify(r)).not.toContain("他社の口座");
      expect(r?.walletOptions.map((w) => w.id)).toEqual([W1]);
    }
  });

  it("入力が無効（filters が null）のときは顧客と口座の選択肢だけ読み、明細は読まない", async () => {
    const { client, calls } = fake({ tables: tables([txn(1)]) });
    const r = await loadLedger(client, CID, 1, null);
    expect(r?.rows).toEqual([]);
    expect(r?.filters).toEqual(NO_FILTERS);
    expect(calls.map((c) => c.table)).not.toContain("bank_transactions");
  });

  it("絞り込みをすり抜けた条件外の行が返ったら例外にする。選択肢の口座の混入・ID重複も例外", async () => {
    const bad = [{ status: "approved" }, { wallet_id: W2 }, { txn_date: "2026-09-01" }, { txn_date: "2026-12-01" }];
    for (const o of bad) {
      const { client } = fake({ tables: { wallets: two }, data: { bank_transactions: [txn(1, o)] } });
      await expect(loadLedger(client, CID, 1, f({ status: "new", walletId: W1, from: "2026-10-01", to: "2026-10-31" }))).rejects.toThrow("絞り込み条件");
    }
    await expect(loadLedger(fake({ data: { wallets: [wallet({ customer_id: OTHER })] } }).client, CID, 1, null)).rejects.toThrow("他の顧客");
  });

  it("絞り込み時も読込エラーは空の結果にせず例外（口座の選択肢・明細）", async () => {
    await expect(loadLedger(fake({ errors: { bank_transactions: { message: "x" } } }).client, CID, 1, f({ status: "new" }))).rejects.toThrow("明細の読込に失敗");
    await expect(loadLedger(fake({ errors: { wallets: { message: "x" } } }).client, CID, 1, f({ status: "new" }))).rejects.toThrow("口座の読込に失敗");
  });
});
