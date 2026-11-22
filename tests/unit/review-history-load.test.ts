import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { HISTORY_PAGE_SIZE, MAX_PAGE, loadReviewHistory, masterKey, parseHistoryPage } from "@/lib/review/history";

const CID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Row = Record<string, unknown>;
type Call = {
  table: string;
  select: string;
  eq: [string, unknown][];
  in: [string, unknown[]][];
  order: [string, boolean][];
  range?: [number, number];
};
type Opts = {
  tables?: Record<string, Row[]>;
  customer?: { data: unknown; error: { message: string } | null };
  /** 1回の応答で返す最大行数（PostgREST の max-rows の模擬） */
  cap?: number;
  errors?: Record<string, { message: string }>;
  /** 表ごとに応答の data を差し替える（形式不正の検証用） */
  data?: Record<string, unknown>;
  /** 表ごとに、絶対位置 base から始まる行の窓を持たせる。range の絶対 offset に応じてその部分だけを返し、窓の外は空（この fake だけの機能） */
  window?: Record<string, { base: number; rows: Row[] }>;
};

/** eq / in / order / range を実際に適用する最小のメモリ上のクライアント。実 DB・RLS は通らない */
function fake(opts: Opts) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, select: "", eq: [], in: [], order: [] };
      calls.push(call);
      const orders: { col: string; asc: boolean }[] = [];
      let range: [number, number] | undefined;
      const run = () => {
        if (opts.errors?.[table]) return { data: null, error: opts.errors[table] };
        const w = opts.window?.[table];
        if (w) {
          const [from, to] = range ?? [w.base, w.base + w.rows.length - 1];
          return { data: w.rows.slice(Math.max(0, from - w.base), Math.max(0, to + 1 - w.base)), error: null };
        }
        if (opts.data && table in opts.data) return { data: opts.data[table], error: null };
        let rows = [...(opts.tables?.[table] ?? [])];
        for (const [c, v] of call.eq) rows = rows.filter((r) => r[c] === v);
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

const review = (n: number, o: Row = {}): Row => ({
  id: `r-${String(n).padStart(4, "0")}`,
  customer_id: CID,
  ai_decision_id: `d-${n}`,
  action: "approve",
  final_entry: { account_item_id: 100, tax_code: 1, partner_id: null, item_id: null, section_id: null, tag_ids: [], description: "文具" },
  diff: {},
  reason: null,
  reviewer_id: U1,
  bulk: false,
  created_at: `2026-10-01T00:00:${String(n % 60).padStart(2, "0")}Z`,
  ...o,
});
const decision = (n: number, o: Row = {}): Row => ({
  id: `d-${n}`,
  customer_id: CID,
  bank_transaction_id: `t-${n}`,
  proposal: { account_item_id: 100, tax_code: 1, partner_id: null, item_id: null, section_id: null, tag_ids: [], description: "文具" },
  ...o,
});
const txn = (n: number, o: Row = {}): Row => ({
  id: `t-${n}`,
  customer_id: CID,
  txn_date: "2026-10-01",
  amount: "12000",
  direction: "expense",
  description: "ACME 文具",
  ...o,
});
const base = (n: number): Record<string, Row[]> => ({
  human_reviews: [review(n)],
  ai_decisions: [decision(n)],
  bank_transactions: [txn(n)],
  staff_members: [{ user_id: U1, display_name: "管理者A" }],
  freee_masters: [
    { customer_id: CID, kind: "account_item", freee_id: 100, name: "消耗品費", available: true },
    { customer_id: CID, kind: "tax", freee_id: 1, name: "課対仕入10%", available: true },
  ],
});

describe("parseHistoryPage", () => {
  it("1以上の整数だけを受け付け、不正・範囲外・複数指定は1にする", () => {
    expect(parseHistoryPage("3")).toBe(3);
    for (const bad of [undefined, "", "0", "-1", "1.5", "abc", "01", "10001", "999999", ["2", "3"]]) {
      expect(parseHistoryPage(bad as string)).toBe(1);
    }
  });
});

describe("loadReviewHistory", () => {
  it("UUID でない顧客IDは DB を読まずに null（404 扱い）にする", async () => {
    const f = fake({});
    await expect(loadReviewHistory(f.client, "not-a-uuid", 1)).resolves.toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it("顧客が見えない（RLS で空）ときは null を返し、履歴を一切読まない", async () => {
    const f = fake({ customer: { data: null, error: null }, tables: base(1) });
    await expect(loadReviewHistory(f.client, CID, 1)).resolves.toBeNull();
    expect(f.calls.map((c) => c.table)).toEqual(["customers"]);
  });

  it("顧客の読込エラー・形式不正・別顧客の応答は例外にする（見えない顧客の null にしない）", async () => {
    await expect(loadReviewHistory(fake({ customer: { data: null, error: { message: "boom" } } }).client, CID, 1)).rejects.toThrow(/顧客の読込に失敗/);
    await expect(loadReviewHistory(fake({ customer: { data: undefined, error: null } }).client, CID, 1)).rejects.toThrow();
    await expect(loadReviewHistory(fake({ customer: { data: { id: OTHER, name: "別会社" }, error: null } }).client, CID, 1)).rejects.toThrow(/一致しません/);
  });

  it("完了済みの承認を、明細・確認者・マスタ名つきで返し、すべての業務データを customer_id で絞る", async () => {
    const f = fake({ tables: base(1) });
    const h = await loadReviewHistory(f.client, CID, 1);
    expect(h?.rows).toHaveLength(1);
    const r = h!.rows[0]!;
    expect(r).toMatchObject({
      reviewId: "r-0001",
      action: "approve",
      decisionId: "d-1",
      reviewer: { id: U1, name: "管理者A" },
      txn: { id: "t-1", date: "2026-10-01", amount: 12000, direction: "expense", description: "ACME 文具" },
      proposal: { state: "ok" },
    });
    expect(h!.masters.get(masterKey("account_item", 100))).toEqual({ name: "消耗品費", available: true });
    // 顧客を持つ表は customer_id を明示して絞る（staff_members は顧客を持たず RLS のみ）
    for (const c of f.calls.filter((c) => ["human_reviews", "ai_decisions", "bank_transactions", "freee_masters"].includes(c.table))) {
      expect(c.eq, c.table).toContainEqual(["customer_id", CID]);
    }
    expect(f.calls.map((c) => c.table)).not.toContain("execution_logs");
  });

  it("他の顧客の確認・判断・明細・マスタが混ざっていたら中止する", async () => {
    const t = base(1);
    // fake は eq を適用するため、応答そのものを差し替えて「絞り込みをすり抜けた混入」を模擬する
    await expect(loadReviewHistory(fake({ tables: t, data: { human_reviews: [review(1, { customer_id: OTHER })] } }).client, CID, 1)).rejects.toThrow(/他の顧客/);
    await expect(loadReviewHistory(fake({ tables: t, data: { ai_decisions: [decision(1, { customer_id: OTHER })] } }).client, CID, 1)).rejects.toThrow(/他の顧客/);
    await expect(loadReviewHistory(fake({ tables: t, data: { bank_transactions: [txn(1, { customer_id: OTHER })] } }).client, CID, 1)).rejects.toThrow(/他の顧客/);
    await expect(
      loadReviewHistory(
        fake({ tables: t, data: { freee_masters: [{ customer_id: OTHER, kind: "tax", freee_id: 1, name: "x", available: true }] } }).client,
        CID,
        1,
      ),
    ).rejects.toThrow(/他の顧客/);
  });

  it("他の顧客の行は eq で除かれ、履歴に含まれない", async () => {
    const t = base(1);
    t.human_reviews!.push(review(2, { customer_id: OTHER }));
    const h = await loadReviewHistory(fake({ tables: t }).client, CID, 1);
    expect(h?.rows.map((r) => r.reviewId)).toEqual(["r-0001"]);
  });

  it("修正は差分と確定内容を返し、保留は理由つきで確定内容なしになる", async () => {
    const t = base(1);
    t.human_reviews = [
      review(2, {
        action: "correct",
        reason: "科目を変更",
        final_entry: { account_item_id: 200, tax_code: 1, partner_id: 7, item_id: null, section_id: null, tag_ids: [3], description: "文具" },
        diff: { account_item_id: { before: 100, after: 200 }, partner_id: { before: null, after: 7 } },
        created_at: "2026-10-02T00:00:00Z",
      }),
      review(3, { action: "hold", reason: "領収書待ち", final_entry: null, reviewer_id: U2, created_at: "2026-10-03T00:00:00Z" }),
    ];
    t.ai_decisions = [decision(2), decision(3)];
    t.bank_transactions = [txn(2), txn(3, { direction: "income" })];
    t.freee_masters = [
      { customer_id: CID, kind: "account_item", freee_id: 200, name: "通信費", available: false },
      { customer_id: CID, kind: "partner", freee_id: 7, name: "ACME", available: true },
      { customer_id: CID, kind: "tag", freee_id: 3, name: "要確認", available: true },
    ];
    const h = await loadReviewHistory(fake({ tables: t }).client, CID, 1);
    const [hold, corrected] = h!.rows;
    expect(hold).toMatchObject({ reviewId: "r-0003", action: "hold", reason: "領収書待ち", finalEntry: null, txn: { direction: "income" } });
    expect(corrected!.diff).toEqual([
      { field: "account_item_id", before: 100, after: 200 },
      { field: "partner_id", before: null, after: 7 },
    ]);
    expect(corrected!.finalEntry).toMatchObject({ account_item_id: 200, tag_ids: [3] });
    expect(h!.masters.get(masterKey("account_item", 200))).toEqual({ name: "通信費", available: false });
    // 担当者の名前が読めない（RLS で空）確認者は名前なしで返す
    expect(hold!.reviewer).toEqual({ id: U2, name: null });
  });

  it("関連データが欠けても履歴を消さず、欠落として返す（判断なし・明細なし・提案なし・形式不正）", async () => {
    const t = base(1);
    t.human_reviews = [review(1), review(2), review(3), review(4, { final_entry: "broken", diff: "broken", action: "correct" })];
    t.ai_decisions = [decision(2, { bank_transaction_id: "t-missing" }), decision(3, { proposal: null }), decision(4, { proposal: ["x"] })];
    t.bank_transactions = [];
    t.freee_masters = [];
    const h = await loadReviewHistory(fake({ tables: t }).client, CID, 1);
    const byId = Object.fromEntries(h!.rows.map((r) => [r.reviewId, r]));
    expect(byId["r-0001"]).toMatchObject({ txn: null, proposal: { state: "unavailable" } }); // 判断の行がない
    expect(byId["r-0002"]).toMatchObject({ txn: null, proposal: { state: "ok" } }); // 明細がない
    expect(byId["r-0003"]).toMatchObject({ proposal: { state: "none" } }); // AI が提案なし
    expect(byId["r-0004"]).toMatchObject({ proposal: { state: "unavailable" }, finalEntry: null, diff: [] });
    expect(h!.masters.size).toBe(0);
  });

  it("50件ちょうどなら次ページなし、51件なら次ページありで50件だけ返す", async () => {
    const mk = (n: number) => ({
      human_reviews: Array.from({ length: n }, (_, i) => review(i + 1, { created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() })),
      ai_decisions: [],
      bank_transactions: [],
    });
    const exact = await loadReviewHistory(fake({ tables: mk(HISTORY_PAGE_SIZE) }).client, CID, 1);
    expect(exact).toMatchObject({ hasNext: false, hasPrevious: false });
    expect(exact!.rows).toHaveLength(HISTORY_PAGE_SIZE);
    const over = await loadReviewHistory(fake({ tables: mk(HISTORY_PAGE_SIZE + 1) }).client, CID, 1);
    expect(over).toMatchObject({ hasNext: true, hasPrevious: false });
    expect(over!.rows).toHaveLength(HISTORY_PAGE_SIZE);
    // 新しい順。最後（最古）の1件は2ページ目
    expect(over!.rows[0]!.reviewId).toBe(`r-${String(HISTORY_PAGE_SIZE + 1).padStart(4, "0")}`);
    const second = await loadReviewHistory(fake({ tables: mk(HISTORY_PAGE_SIZE + 1) }).client, CID, 2);
    expect(second!.rows.map((r) => r.reviewId)).toEqual(["r-0001"]);
    expect(second).toMatchObject({ hasNext: false, hasPrevious: true, page: 2 });
  });

  it("範囲外のページは空で返し、エラーにも次ページありにもしない", async () => {
    const h = await loadReviewHistory(fake({ tables: base(1) }).client, CID, 5);
    expect(h).toMatchObject({ rows: [], hasNext: false, hasPrevious: true, page: 5 });
  });

  it("同じ時刻の確認は id の降順で並び、ページをまたいでも重複・欠落しない", async () => {
    const same = "2026-10-01T09:00:00Z";
    const total = HISTORY_PAGE_SIZE + 5;
    const tables = {
      human_reviews: Array.from({ length: total }, (_, i) => review(i + 1, { created_at: same })),
      ai_decisions: [],
      bank_transactions: [],
    };
    const p1 = await loadReviewHistory(fake({ tables }).client, CID, 1);
    const p2 = await loadReviewHistory(fake({ tables }).client, CID, 2);
    const ids = [...p1!.rows, ...p2!.rows].map((r) => r.reviewId);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    expect(ids).toEqual([...ids].sort().reverse());
  });

  it("order は created_at 降順→id 降順で、range は offset と +1 件を指定する", async () => {
    const f = fake({ tables: base(1) });
    await loadReviewHistory(f.client, CID, 3);
    const c = f.calls.find((x) => x.table === "human_reviews")!;
    expect(c.order).toEqual([
      ["created_at", false],
      ["id", false],
    ]);
    expect(c.range).toEqual([2 * HISTORY_PAGE_SIZE, 2 * HISTORY_PAGE_SIZE + HISTORY_PAGE_SIZE]);
  });

  it("サーバーの応答上限で行が切れても、必要な件数まで続けて読み、次ページ判定を誤らない", async () => {
    const total = HISTORY_PAGE_SIZE + 3;
    const tables = {
      human_reviews: Array.from({ length: total }, (_, i) => review(i + 1, { created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() })),
      ai_decisions: [],
      bank_transactions: [],
    };
    const f = fake({ tables, cap: 20 });
    const h = await loadReviewHistory(f.client, CID, 1);
    expect(h!.rows).toHaveLength(HISTORY_PAGE_SIZE);
    expect(h!.hasNext).toBe(true);
    expect(f.calls.filter((c) => c.table === "human_reviews").length).toBeGreaterThan(1);
    // 最終ページも、上限で切れた応答を「終わり」とみなさない
    const last = await loadReviewHistory(fake({ tables, cap: 2 }).client, CID, 2);
    expect(last!.rows.map((r) => r.reviewId)).toEqual(["r-0003", "r-0002", "r-0001"]);
    expect(last!.hasNext).toBe(false);
  });

  it("最終ページ（MAX_PAGE）では、より古い記録があっても次ページなしとし、辿れない旨を別に返す", async () => {
    // 49,950 行目以降を実際に作らず、その位置（base）から始まる行の窓だけを持たせる。range の絶対 offset に応じて窓の該当部分を返し、窓の外は空
    const reviews = Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, i) => review(i + 1, { created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() }));
    const offset = (MAX_PAGE - 1) * HISTORY_PAGE_SIZE;
    const empty = { ai_decisions: [], bank_transactions: [] };
    const humanCalls = (f: ReturnType<typeof fake>) => f.calls.filter((c) => c.table === "human_reviews");
    const f = fake({ window: { human_reviews: { base: offset, rows: reviews } }, tables: empty });
    const last = await loadReviewHistory(f.client, CID, MAX_PAGE);
    expect(last).toMatchObject({ page: MAX_PAGE, hasNext: false, hasPrevious: true, olderBeyondLimit: true });
    expect(last!.rows).toHaveLength(HISTORY_PAGE_SIZE);
    // 51件が1回で返るので追加の読込はない
    expect(humanCalls(f).map((c) => c.range)).toEqual([[offset, offset + HISTORY_PAGE_SIZE]]);
    // 最終ページちょうどで終わるなら、古い記録の案内も出さない。残り1件を続けて問い合わせ、空の応答で終わる
    const fe = fake({ window: { human_reviews: { base: offset, rows: reviews.slice(0, HISTORY_PAGE_SIZE) } }, tables: empty });
    const exact = await loadReviewHistory(fe.client, CID, MAX_PAGE);
    expect(exact).toMatchObject({ hasNext: false, olderBeyondLimit: false });
    expect(exact!.rows).toHaveLength(HISTORY_PAGE_SIZE);
    expect(humanCalls(fe).map((c) => c.range)).toEqual([
      [offset, offset + HISTORY_PAGE_SIZE],
      [offset + HISTORY_PAGE_SIZE, offset + HISTORY_PAGE_SIZE],
    ]);
    // 1つ手前のページは通常どおり次ページあり。到達可能な次ページ番号は常に MAX_PAGE 以下
    const prevOffset = (MAX_PAGE - 2) * HISTORY_PAGE_SIZE;
    const prev = await loadReviewHistory(fake({ window: { human_reviews: { base: prevOffset, rows: reviews } }, tables: empty }).client, CID, MAX_PAGE - 1);
    expect(prev).toMatchObject({ hasNext: true, olderBeyondLimit: false });
    expect(parseHistoryPage(String(MAX_PAGE))).toBe(MAX_PAGE);
  });

  it("読込エラー・null・形式不正・不明な操作は、空の履歴にせず例外にする", async () => {
    for (const table of ["human_reviews", "ai_decisions", "bank_transactions", "staff_members", "freee_masters"]) {
      await expect(loadReviewHistory(fake({ tables: base(1), errors: { [table]: { message: "denied sk-secret" } } }).client, CID, 1)).rejects.toThrow(/読込に失敗/);
      await expect(loadReviewHistory(fake({ tables: base(1), data: { [table]: null } }).client, CID, 1)).rejects.toThrow(/読込に失敗/);
    }
    await expect(loadReviewHistory(fake({ data: { human_reviews: [review(1, { action: "delete" })] } }).client, CID, 1)).rejects.toThrow();
    await expect(loadReviewHistory(fake({ data: { human_reviews: [review(1), review(1)] } }).client, CID, 1)).rejects.toThrow(/重複/);
    await expect(loadReviewHistory(fake({ data: { human_reviews: [{ id: "a" }] } }).client, CID, 1)).rejects.toThrow();
  });

  it("不正なページ番号は DB を読む前に拒否する", async () => {
    for (const p of [0, -1, 1.5, 10001]) {
      const f = fake({});
      await expect(loadReviewHistory(f.client, CID, p)).rejects.toThrow(/ページ番号/);
      expect(f.calls).toHaveLength(0);
    }
  });
});
