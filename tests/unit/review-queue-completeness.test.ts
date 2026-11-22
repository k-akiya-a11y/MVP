import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { ReviewQueueLoadError, loadReviewQueue } from "@/lib/review/queue";

const CID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORIGINAL_SELECT = "id, txn_date, amount, description, status";

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
  /** 2ページ目以降（range の開始が 0 より大きい）の問い合わせだけを失敗・null にする */
  laterPage?: (call: Call) => "error" | "null" | undefined;
  admin?: { data: unknown; error: { message: string } | null };
};

/** eq / in / order / range / cap を実際に適用する最小のメモリ上のクライアント。実 DB・RLS・view は通らない */
function fake(opts: Opts) {
  const calls: Call[] = [];
  const rpcs: string[] = [];
  const client = {
    rpc(name: string) {
      rpcs.push(name);
      return Promise.resolve(opts.admin ?? { data: true, error: null });
    },
    from(table: string) {
      const call: Call = { table, select: "", eq: [], in: [], order: [] };
      calls.push(call);
      let range: [number, number] | undefined;
      const run = () => {
        if (range && range[0] > 0) {
          const f = opts.laterPage?.(call);
          if (f === "error") return { data: null, error: { message: "denied sk-secret-token" } };
          if (f === "null") return { data: null, error: null };
        }
        let rows = [...(opts.tables?.[table] ?? [])];
        for (const [c, v] of call.eq) rows = rows.filter((r) => r[c] === v);
        for (const [c, vs] of call.in) rows = rows.filter((r) => vs.includes(r[c]));
        for (const [col, asc] of [...call.order].reverse()) {
          rows.sort((a, b) => {
            const x = String(a[col]);
            const y = String(b[col]);
            return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
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
        order: (col: string, o?: { ascending?: boolean }) => (call.order.push([col, o?.ascending ?? true]), q),
        range: (from: number, to: number) => ((range = [from, to]), (call.range = range), q),
        maybeSingle: async () => opts.customer ?? { data: { id: CID, name: "テスト商事" }, error: null },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { client, calls, rpcs };
}

const pad = (n: number) => String(n).padStart(5, "0");
const entry = { account_item_id: 100, tax_code: 1, partner_id: null, item_id: null, section_id: null, tag_ids: [], description: "文具" };
const breakdown = {
  rule: { matched: false, ruleId: null, version: null },
  past: { matchType: "none", total: 0, majority: null },
  checks: [],
  forcedLow: [],
  reasons: [],
};
const txn = (n: number, o: Row = {}): Row => ({
  id: `t-${pad(n)}`,
  customer_id: CID,
  wallet_id: "w-1",
  txn_date: "2026-10-01",
  amount: "12000",
  direction: "expense",
  description: `明細${n}`,
  status: "proposed",
  ...o,
});
const decision = (n: number, o: Row = {}): Row => ({
  id: `d-${pad(n)}`,
  customer_id: CID,
  bank_transaction_id: `t-${pad(n)}`,
  created_at: "2026-10-02T00:00:00Z",
  confidence: "medium",
  proposal: entry,
  confidence_breakdown: breakdown,
  past_entry_ids: [],
  ai_reason: null,
  ai_unknowns: [],
  model: null,
  ...o,
});
const past = (n: number, o: Row = {}): Row => ({
  id: `p-${pad(n)}`,
  customer_id: CID,
  entry_date: "2026-09-01",
  amount: "5000",
  bank_description: "ACME",
  ...entry,
  ...o,
});
const hold = (n: number, decisionN: number, o: Row = {}): Row => ({
  id: `h-${pad(n)}`,
  customer_id: CID,
  ai_decision_id: `d-${pad(decisionN)}`,
  action: "hold",
  reason: `理由${n}`,
  reviewer_id: U1,
  created_at: "2026-10-03T00:00:00Z",
  ...o,
});
const suspect = (n: number, originalN: number, o: Row = {}): Row =>
  txn(n, { status: "duplicate_suspected", duplicate_of_id: `t-${pad(originalN)}`, ...o });

/** 明細 n 件（候補作成済）と、それぞれの最新判断だけを持つ基本の表 */
function base(n: number): Record<string, Row[]> {
  return {
    bank_transactions: Array.from({ length: n }, (_, i) => txn(i + 1)),
    latest_ai_decisions: Array.from({ length: n }, (_, i) => decision(i + 1)),
    wallets: [{ id: "w-1", customer_id: CID, name: "普通預金", kind: "bank" }],
    freee_masters: [{ customer_id: CID, kind: "account_item", freee_id: 100, name: "消耗品費", available: true }],
    past_journal_entries: [],
    human_reviews: [],
    staff_members: [
      { user_id: U1, display_name: "管理者A" },
      { user_id: U2, display_name: "担当者B" },
    ],
  };
}

const callsTo = (calls: Call[], table: string) => calls.filter((c) => c.table === table);

describe("loadReviewQueue: 応答上限と完全性", () => {
  it("応答上限が1行でも、明細・判断・過去仕訳・保留・担当者名・重複元がすべて揃う", async () => {
    const t = base(3);
    t.latest_ai_decisions = [
      decision(1, { past_entry_ids: ["p-00001", "p-00002"] }),
      decision(2, { past_entry_ids: ["p-00002"] }),
      decision(3),
    ];
    t.past_journal_entries = [past(1), past(2)];
    t.human_reviews = [hold(1, 1, { reviewer_id: U1 }), hold(2, 1, { reviewer_id: U2 }), hold(3, 2, { reviewer_id: U1 })];
    // 重複の疑い 2 件。重複元（status new）は 1 つの顧客内に 2 件
    t.bank_transactions!.push(txn(10, { status: "new" }), txn(11, { status: "new" }), suspect(20, 10), suspect(21, 11));
    const f = fake({ tables: t, cap: 1 });
    const q = await loadReviewQueue(f.client, CID);
    expect(q!.items.map((i) => i.txn.id)).toEqual(["t-00001", "t-00002", "t-00003"]);
    expect(q!.items[0]!.pastExamples.map((p) => p.id)).toEqual(["p-00001", "p-00002"]);
    expect(q!.items[1]!.pastExamples.map((p) => p.id)).toEqual(["p-00002"]);
    expect(q!.items[0]!.holds.map((h) => [h.reason, h.reviewerName])).toEqual([
      ["理由1", "管理者A"],
      ["理由2", "担当者B"],
    ]);
    expect(q!.items[1]!.holds.map((h) => h.reviewerName)).toEqual(["管理者A"]);
    expect(q!.suspectedDuplicates.map((s) => [s.id, s.original.id])).toEqual([
      ["t-00020", "t-00010"],
      ["t-00021", "t-00011"],
    ]);
    expect(q!.wallets).toHaveLength(1);
    expect(q!.masters.account_item).toEqual([{ id: 100, name: "消耗品費" }]);
    // 上限が 1 なので、2 行以上を持つ表は複数回に分けて読んでいる
    expect(callsTo(f.calls, "latest_ai_decisions").length).toBeGreaterThan(1);
    expect(callsTo(f.calls, "human_reviews").length).toBeGreaterThan(1);
    expect(callsTo(f.calls, "past_journal_entries").length).toBeGreaterThan(1);
  });

  it("保留が1,000件を超え、同時刻でも、id 昇順で重複・欠落なく読める（上限なし／上限300）", async () => {
    const total = 1205;
    const t = base(1);
    // 同じ created_at の保留が 1,205 件。fake は order を守るので、tie-break の id が無いと順序は保証されない
    t.human_reviews = Array.from({ length: total }, (_, i) => hold(total - i, 1, { created_at: "2026-10-03T00:00:00Z", reviewer_id: i % 2 ? U1 : U2 }));
    for (const cap of [undefined, 300]) {
      const f = fake({ tables: t, cap });
      const q = await loadReviewQueue(f.client, CID);
      const reasons = q!.items[0]!.holds.map((h) => h.reason);
      expect(reasons).toHaveLength(total);
      expect(new Set(reasons).size).toBe(total);
      expect(reasons).toEqual(Array.from({ length: total }, (_, i) => `理由${i + 1}`));
      const c = callsTo(f.calls, "human_reviews")[0]!;
      expect(c.order).toEqual([
        ["created_at", true],
        ["id", true],
      ]);
      expect(c.range).toEqual([0, 999]);
    }
  });

  it("保留は時刻の古い順に並ぶ（同時刻は id 順）", async () => {
    const t = base(1);
    t.human_reviews = [
      hold(1, 1, { created_at: "2026-10-05T00:00:00Z" }),
      hold(2, 1, { created_at: "2026-10-04T00:00:00Z" }),
      hold(3, 1, { created_at: "2026-10-04T00:00:00Z" }),
    ];
    const q = await loadReviewQueue(fake({ tables: t, cap: 2 }).client, CID);
    expect(q!.items[0]!.holds.map((h) => h.reason)).toEqual(["理由2", "理由3", "理由1"]);
  });

  it("ID が200件を超えても、チャンクは200件以下で、各チャンクの全行を読む（450件・上限7）", async () => {
    const n = 450;
    const t = base(n);
    t.latest_ai_decisions = Array.from({ length: n }, (_, i) => decision(i + 1, { past_entry_ids: [`p-${pad(i + 1)}`] }));
    t.past_journal_entries = Array.from({ length: n }, (_, i) => past(i + 1));
    t.human_reviews = Array.from({ length: n }, (_, i) => hold(i + 1, i + 1));
    const f = fake({ tables: t, cap: 7 });
    const q = await loadReviewQueue(f.client, CID);
    expect(q!.items).toHaveLength(n);
    expect(q!.items.every((i) => i.pastExamples.length === 1 && i.holds.length === 1)).toBe(true);
    for (const table of ["latest_ai_decisions", "past_journal_entries", "human_reviews"]) {
      const sizes = callsTo(f.calls, table).flatMap((c) => c.in.map(([, v]) => v.length));
      expect(Math.max(...sizes), table).toBeLessThanOrEqual(200);
      // 先頭ページ（range 開始 0）は 450 件を 200/200/50 に分けた 3 回
      expect(callsTo(f.calls, table).filter((c) => c.range?.[0] === 0).map((c) => c.in[0]![1].length), table).toEqual([200, 200, 50]);
    }
  });

  it("重複元が200件を超えても読み切る", async () => {
    const n = 230;
    const t = base(0);
    t.latest_ai_decisions = [];
    t.bank_transactions = [
      ...Array.from({ length: n }, (_, i) => txn(i + 1, { status: "new" })),
      ...Array.from({ length: n }, (_, i) => suspect(1000 + i, i + 1)),
    ];
    const f = fake({ tables: t, cap: 50 });
    const q = await loadReviewQueue(f.client, CID);
    expect(q!.suspectedDuplicates).toHaveLength(n);
    const sizes = callsTo(f.calls, "bank_transactions")
      .filter((c) => c.select === ORIGINAL_SELECT && c.range?.[0] === 0)
      .map((c) => c.in[0]![1].length);
    expect(sizes).toEqual([200, 30]);
  });

  it("関連行の問い合わせは顧客IDで絞る（staff_members は顧客を持たず RLS のみ）", async () => {
    const t = base(1);
    t.latest_ai_decisions = [decision(1, { past_entry_ids: ["p-00001"] })];
    t.past_journal_entries = [past(1)];
    t.human_reviews = [hold(1, 1)];
    t.bank_transactions!.push(txn(10, { status: "new" }), suspect(20, 10));
    const f = fake({ tables: t });
    await loadReviewQueue(f.client, CID);
    for (const table of ["latest_ai_decisions", "past_journal_entries", "human_reviews", "wallets", "freee_masters"]) {
      const cs = callsTo(f.calls, table);
      expect(cs.length, table).toBeGreaterThan(0);
      for (const c of cs) expect(c.eq, table).toContainEqual(["customer_id", CID]);
    }
    for (const c of callsTo(f.calls, "bank_transactions")) expect(c.eq).toContainEqual(["customer_id", CID]);
    expect(callsTo(f.calls, "staff_members").length).toBeGreaterThan(0);
    for (const c of callsTo(f.calls, "staff_members")) expect(c.eq).toEqual([]);
    // 並びは一意（tie-break に id か主キー）
    for (const c of f.calls.filter((c) => c.table !== "customers")) {
      expect(c.order.length, `${c.table} ${c.select}`).toBeGreaterThan(0);
      expect(c.range, c.table).toBeDefined();
    }
  });

  it("別顧客の判断・過去仕訳・保留は使わない（顧客絞り込みで除かれる）", async () => {
    const t = base(1);
    t.latest_ai_decisions = [decision(1, { past_entry_ids: ["p-00001"] })];
    t.past_journal_entries = [past(1, { customer_id: OTHER })];
    t.human_reviews = [hold(1, 1, { customer_id: OTHER })];
    const q = await loadReviewQueue(fake({ tables: t }).client, CID);
    expect(q!.items[0]!.pastExamples).toEqual([]);
    expect(q!.items[0]!.holds).toEqual([]);
    // 判断が別顧客のものしか無い明細は、他顧客の判断で埋めずに失敗する
    const t2 = base(1);
    t2.latest_ai_decisions = [decision(1, { customer_id: OTHER })];
    await expect(loadReviewQueue(fake({ tables: t2 }).client, CID)).rejects.toBeInstanceOf(ReviewQueueLoadError);
  });
});

describe("loadReviewQueue: 読込失敗は空のキューにしない", () => {
  const later: Record<string, (c: Call) => boolean> = {
    明細: (c) => c.table === "bank_transactions" && c.select.includes("wallet_id, txn_date, amount, direction, description, status"),
    仕訳候補: (c) => c.table === "latest_ai_decisions",
    過去仕訳: (c) => c.table === "past_journal_entries",
    保留: (c) => c.table === "human_reviews",
    担当者: (c) => c.table === "staff_members",
    重複元: (c) => c.table === "bank_transactions" && c.select === ORIGINAL_SELECT,
    重複の疑い: (c) => c.table === "bank_transactions" && c.select.includes("duplicate_of_id"),
  };
  /** 各表が 2 行以上あり、上限 1 なら必ず 2 ページ目を読む表 */
  function twoPage(): Record<string, Row[]> {
    const t = base(2);
    t.latest_ai_decisions = [decision(1, { past_entry_ids: ["p-00001", "p-00002"] }), decision(2)];
    t.past_journal_entries = [past(1), past(2)];
    t.human_reviews = [hold(1, 1, { reviewer_id: U1 }), hold(2, 1, { reviewer_id: U2 })];
    t.bank_transactions!.push(txn(10, { status: "new" }), txn(11, { status: "new" }), suspect(20, 10), suspect(21, 11));
    return t;
  }

  for (const [name, match] of Object.entries(later)) {
    for (const kind of ["error", "null"] as const) {
      it(`${name}の2ページ目が ${kind} なら、途中までの行で返さず例外にする`, async () => {
        const f = fake({ tables: twoPage(), cap: 1, laterPage: (c) => (match(c) ? kind : undefined) });
        const err = await loadReviewQueue(f.client, CID).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err, name).toBeInstanceOf(Error);
        // 2 ページ目を実際に読みに行っている（テストが素通りしていない）
        expect(f.calls.some((c) => match(c) && (c.range?.[0] ?? 0) > 0), name).toBe(true);
      });
    }
  }

  it("最新の判断が無い明細があれば、全件読んだ後に固定文言の例外にする（ID・応答を含まない）", async () => {
    const t = base(2);
    t.latest_ai_decisions = [decision(1)];
    const err = await loadReviewQueue(fake({ tables: t }).client, CID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewQueueLoadError);
    expect((err as Error).message).toBe("承認画面のデータを読み込めませんでした。時間をおいて再読み込みしてください。");
    expect((err as Error).message).not.toMatch(/t-0000|d-0000|sk-|customer/);
  });

  it("重複元が無い重複の疑いがあれば、隠さず例外にする", async () => {
    const t = base(0);
    t.latest_ai_decisions = [];
    t.bank_transactions = [suspect(20, 10)];
    await expect(loadReviewQueue(fake({ tables: t }).client, CID)).rejects.toBeInstanceOf(ReviewQueueLoadError);
    // 重複元が別顧客にしか無い場合も同じ
    t.bank_transactions = [suspect(20, 10), txn(10, { status: "new", customer_id: OTHER })];
    await expect(loadReviewQueue(fake({ tables: t }).client, CID)).rejects.toBeInstanceOf(ReviewQueueLoadError);
  });

  it("同じ明細に判断が複数返ったら、最新を決められないので例外にする", async () => {
    const t = base(1);
    t.latest_ai_decisions = [decision(1), decision(1, { id: "d-dup" })];
    await expect(loadReviewQueue(fake({ tables: t }).client, CID)).rejects.toBeInstanceOf(ReviewQueueLoadError);
  });

  it("真に空（対象の明細も重複の疑いも無い）なら、空のキューを返し、関連表は読まない", async () => {
    const t = base(0);
    t.latest_ai_decisions = [];
    const f = fake({ tables: t });
    const q = await loadReviewQueue(f.client, CID);
    expect(q).toMatchObject({ items: [], suspectedDuplicates: [], canApprove: true });
    for (const table of ["latest_ai_decisions", "past_journal_entries", "human_reviews", "staff_members"]) {
      expect(callsTo(f.calls, table), table).toHaveLength(0);
    }
  });

  it("任意の参照は従来どおり: 無い過去仕訳の例は省き、読めない担当者は「担当者」と表示する", async () => {
    const t = base(1);
    t.latest_ai_decisions = [decision(1, { past_entry_ids: ["p-00001", "p-missing"] })];
    t.past_journal_entries = [past(1)];
    t.human_reviews = [hold(1, 1, { reviewer_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })];
    const q = await loadReviewQueue(fake({ tables: t }).client, CID);
    expect(q!.items[0]!.pastExamples.map((p) => p.id)).toEqual(["p-00001"]);
    expect(q!.items[0]!.holds).toEqual([{ reason: "理由1", reviewerName: "担当者", at: "2026-10-03T00:00:00Z" }]);
  });
});

describe("loadReviewQueue: 権限・顧客・非変更", () => {
  it("顧客が見えない（RLS で null）なら null を返し、二次読込も権限の問い合わせもしない", async () => {
    const f = fake({ customer: { data: null, error: null }, tables: base(2) });
    await expect(loadReviewQueue(f.client, CID)).resolves.toBeNull();
    expect(f.calls.map((c) => c.table)).toEqual(["customers"]);
    expect(f.rpcs).toEqual([]);
  });

  it("顧客の読込エラーは null（404）にせず例外にする", async () => {
    await expect(loadReviewQueue(fake({ customer: { data: null, error: { message: "boom" } } }).client, CID)).rejects.toThrow(/顧客の読込に失敗/);
  });

  it("canApprove は is_admin の結果そのまま（管理者 true・担当者 false）で、承認の中身は変わらない", async () => {
    const t = base(1);
    const admin = fake({ tables: t, admin: { data: true, error: null } });
    const staff = fake({ tables: t, admin: { data: false, error: null } });
    const a = await loadReviewQueue(admin.client, CID);
    const s = await loadReviewQueue(staff.client, CID);
    expect(a!.canApprove).toBe(true);
    expect(s!.canApprove).toBe(false);
    expect(a!.items).toEqual(s!.items);
    expect(admin.rpcs).toEqual(["is_admin"]);
    expect(staff.rpcs).toEqual(["is_admin"]);
  });

  it("is_admin の読込エラー・真偽値でない応答は例外にする（承認可として扱わない）", async () => {
    await expect(loadReviewQueue(fake({ tables: base(1), admin: { data: null, error: { message: "x" } } }).client, CID)).rejects.toThrow();
    await expect(loadReviewQueue(fake({ tables: base(1), admin: { data: "yes", error: null } }).client, CID)).rejects.toThrow();
  });

  it("読み取りだけを行う（rpc は is_admin のみ。fake は insert/update/delete を持たず、呼べば失敗する）", async () => {
    const f = fake({ tables: base(2) });
    const q = await loadReviewQueue(f.client, CID);
    expect(q!.items.map((i) => i.txn.status)).toEqual(["proposed", "proposed"]);
    expect(f.rpcs).toEqual(["is_admin"]);
  });

  it("保留の明細は status on_hold のまま返し、保留の記録を付ける", async () => {
    const t = base(1);
    t.bank_transactions = [txn(1, { status: "on_hold" })];
    t.human_reviews = [hold(1, 1)];
    const q = await loadReviewQueue(fake({ tables: t }).client, CID);
    expect(q!.items[0]!.txn.status).toBe("on_hold");
    expect(q!.items[0]!.holds).toHaveLength(1);
  });
});

// 数値境界。DB の応答の不正な数値が 0 / 1 に化けて金額・ID として通らないこと。
// 画面側の失敗表示（例外 → 固定の読み取り専用エラー、操作部品なし）は customer-review-page.test.ts が検査済みで、ここでは繰り返さない。
// fake は DB が返し得る応答の模擬で、実 DB・RLS・PostgREST の列型による防御は通らない。
describe("loadReviewQueue: 数値境界（不正な数値は 0 / 1 にせず読込失敗にする）", () => {
  /** 必須の整数の位置で拒否されるべき値。null は必須の位置では不正（任意 ID の位置では正当なので nullable で除く） */
  const invalidInts: [string, unknown][] = [
    ["null", null],
    ["空文字", ""],
    ["空白のみ", "   "],
    ["true", true],
    ["false", false],
    ["空配列", []],
    ["配列 [1]", [1]],
    ["配列 ['1']", ["1"]],
    ["小数 1.5", 1.5],
    ["小数文字列 '1.5'", "1.5"],
    ["指数文字列 '1e3'", "1e3"],
    ["指数文字列 '1E3'", "1E3"],
    ["16進文字列 '0x10'", "0x10"],
    ["Infinity", Infinity],
    ["NaN", NaN],
    ["安全整数超の数値", Number.MAX_SAFE_INTEGER + 1],
    ["安全整数超の文字列", "9007199254740993"],
    // 技術的な直列化形式（10 進の整数、符号は "-" のみ）に合わない文字列
    ["前後に空白 ' 12 '", " 12 "],
    ["末尾に空白 '12 '", "12 "],
    ["小数 '1.0'", "1.0"],
    ["プラス符号 '+5'", "+5"],
    ["全角数字", "１２"],
    ["符号だけ '-'", "-"],
  ];
  const invalidFor = (nullable: boolean) => invalidInts.filter(([, v]) => !(nullable && v === null));

  type Position = {
    name: string;
    nullable?: boolean;
    /** 不正値 v を 1 か所だけに入れた、他は正常な表 */
    tables: (v: unknown) => Record<string, Row[]>;
  };
  const withTxnAmount = (v: unknown) => {
    const t = base(1);
    t.bank_transactions = [txn(1, { amount: v })];
    return t;
  };
  const withProposal = (field: string, asTag: boolean) => (v: unknown) => {
    const t = base(1);
    t.latest_ai_decisions = [decision(1, { proposal: { ...entry, [field]: asTag ? [v] : v } })];
    return t;
  };
  const withPast = (o: (v: unknown) => Row) => (v: unknown) => {
    const t = base(1);
    t.latest_ai_decisions = [decision(1, { past_entry_ids: ["p-00001"] })];
    t.past_journal_entries = [past(1, o(v))];
    return t;
  };
  const withDuplicate = (side: "suspect" | "original") => (v: unknown) => {
    const t = base(0);
    t.latest_ai_decisions = [];
    t.bank_transactions = [
      txn(10, { status: "new", ...(side === "original" ? { amount: v } : {}) }),
      suspect(20, 10, side === "suspect" ? { amount: v } : {}),
    ];
    return t;
  };

  const positions: Position[] = [
    { name: "明細 amount", tables: withTxnAmount },
    { name: "重複の疑い amount", tables: withDuplicate("suspect") },
    { name: "重複元 amount", tables: withDuplicate("original") },
    { name: "過去仕訳 amount", tables: withPast((v) => ({ amount: v })) },
    { name: "過去仕訳 account_item_id", tables: withPast((v) => ({ account_item_id: v })) },
    { name: "過去仕訳 tax_code", tables: withPast((v) => ({ tax_code: v })) },
    { name: "過去仕訳 partner_id", nullable: true, tables: withPast((v) => ({ partner_id: v })) },
    { name: "過去仕訳 item_id", nullable: true, tables: withPast((v) => ({ item_id: v })) },
    { name: "過去仕訳 section_id", nullable: true, tables: withPast((v) => ({ section_id: v })) },
    { name: "過去仕訳 tag_ids の要素", tables: withPast((v) => ({ tag_ids: [v] })) },
    {
      name: "マスタ freee_id",
      tables: (v) => {
        const t = base(0);
        t.latest_ai_decisions = [];
        t.freee_masters = [{ customer_id: CID, kind: "account_item", freee_id: v, name: "消耗品費", available: true }];
        return t;
      },
    },
    { name: "仕訳候補 account_item_id", tables: withProposal("account_item_id", false) },
    { name: "仕訳候補 tax_code", tables: withProposal("tax_code", false) },
    { name: "仕訳候補 partner_id", nullable: true, tables: withProposal("partner_id", false) },
    { name: "仕訳候補 item_id", nullable: true, tables: withProposal("item_id", false) },
    { name: "仕訳候補 section_id", nullable: true, tables: withProposal("section_id", false) },
    { name: "仕訳候補 tag_ids の要素", tables: withProposal("tag_ids", true) },
  ];

  for (const p of positions) {
    it(`${p.name}: 不正な値はすべて例外にする（0 / 1 や部分的なキューを返さない）`, async () => {
      // 正常な表そのものは通る（位置の組み立てが誤りで常に失敗しているテストを防ぐ）
      const valid = p.name.endsWith("freee_id") ? 100 : p.name.endsWith("tag_ids の要素") ? 7 : 12000;
      await expect(loadReviewQueue(fake({ tables: p.tables(valid) }).client, CID), `${p.name} の正常値`).resolves.not.toBeNull();

      const accepted: string[] = [];
      for (const [label, v] of invalidFor(p.nullable ?? false)) {
        const result = await loadReviewQueue(fake({ tables: p.tables(v) }).client, CID).then(
          () => "resolved",
          () => "rejected",
        );
        if (result === "resolved") accepted.push(label);
      }
      // 通ってしまった値の一覧（空であるべき）
      expect(accepted, `${p.name} で拒否されなかった値`).toEqual([]);
    });
  }

  it("正当な値は従来どおり通る（整数の数値・10 進の整数文字列・tax_code 0・任意 ID の null・空の tags・過去仕訳の負の金額）", async () => {
    const t = base(2);
    t.bank_transactions = [txn(1, { amount: "12000" }), txn(2, { amount: 8000 }), txn(10, { status: "new", amount: "3000" }), suspect(20, 10, { amount: 3000 })];
    t.latest_ai_decisions = [
      decision(1, {
        past_entry_ids: ["p-00001"],
        proposal: { account_item_id: "100", tax_code: 0, partner_id: null, item_id: "5", section_id: null, tag_ids: ["7", 8], description: "文具" },
      }),
      decision(2, { proposal: { ...entry, tax_code: "0", tag_ids: [] } }),
    ];
    t.past_journal_entries = [past(1, { amount: "-300", account_item_id: "100", tax_code: 0, tag_ids: [] })];
    t.freee_masters = [
      { customer_id: CID, kind: "account_item", freee_id: "100", name: "消耗品費", available: true },
      { customer_id: CID, kind: "tax", freee_id: 0, name: "対象外", available: true },
    ];
    const q = await loadReviewQueue(fake({ tables: t }).client, CID);
    expect(q!.items.map((i) => i.txn.amount)).toEqual([12000, 8000]);
    expect(q!.items[0]!.proposal).toEqual({ account_item_id: 100, tax_code: 0, partner_id: null, item_id: 5, section_id: null, tag_ids: [7, 8], description: "文具" });
    expect(q!.items[1]!.proposal).toEqual({ account_item_id: 100, tax_code: 0, partner_id: null, item_id: null, section_id: null, tag_ids: [], description: "文具" });
    expect(q!.items[0]!.pastExamples.map((p) => [p.amount, p.entry.tax_code, p.entry.tag_ids])).toEqual([[-300, 0, []]]);
    expect(q!.masters.account_item).toEqual([{ id: 100, name: "消耗品費" }]);
    expect(q!.masters.tax).toEqual([{ id: 0, name: "対象外" }]);
    expect(q!.suspectedDuplicates.map((s) => [s.amount, s.original.amount])).toEqual([[3000, 3000]]);
  });

  it("整数文字列の形式は技術的な直列化形式（-? の 10 進数字）: 先頭ゼロは数値化し、'-0' は 0 にする", async () => {
    const t = base(2);
    t.bank_transactions = [txn(1, { amount: "007" }), txn(2, { amount: "-0" })];
    const q = await loadReviewQueue(fake({ tables: t }).client, CID);
    expect(q!.items.map((i) => i.txn.amount)).toEqual([7, 0]);
    expect(Object.is(q!.items[1]!.txn.amount, 0)).toBe(true);
  });
});
