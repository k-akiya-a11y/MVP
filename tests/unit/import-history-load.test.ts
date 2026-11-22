import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { IMPORT_MAX_PAGE, IMPORT_PAGE_SIZE, MAX_DETAIL_ITEMS, loadImportHistory } from "@/lib/statements/history";

const CID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const W1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
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
  /** 表ごとに応答の data を差し替える（形式不正・絞り込みをすり抜けた混入の検証用） */
  data?: Record<string, unknown>;
  /** 表ごとに、絶対位置 base から始まる行の窓を持たせる（range の絶対 offset に応じてその部分だけを返し、窓の外は空） */
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

const id = (n: number) => `i-${String(n).padStart(4, "0")}`;
/** 成功の取込: 元の5行 = 読めた4（登録2・読み飛ばし1・疑い1）+ 金額0の1行。13,000円 = 8,000 + 2,000 + 3,000 */
const imp = (n: number, o: Row = {}): Row => ({
  id: id(n),
  customer_id: CID,
  wallet_id: W1,
  source: "csv",
  file_name: "oct.csv",
  csv_format: "bank_generic",
  imported_by: U1,
  imported_at: `2026-10-03T05:00:${String(n % 60).padStart(2, "0")}Z`,
  status: "completed",
  source_row_count: 5,
  row_count: 4,
  inserted_count: 2,
  skipped_duplicate_count: 1,
  suspected_duplicate_count: 1,
  ignored_rows: [{ line: 5, reason: "金額が0" }],
  errors: [],
  income_total: 10000,
  expense_total: 3000,
  inserted_amount_total: 8000,
  skipped_amount_total: 2000,
  suspected_amount_total: 3000,
  ...o,
});
const failedImp = (n: number, o: Row = {}): Row =>
  imp(n, {
    status: "failed",
    csv_format: "card_generic",
    file_name: "card.csv",
    source_row_count: 20,
    row_count: 0,
    inserted_count: 0,
    skipped_duplicate_count: 0,
    suspected_duplicate_count: 0,
    ignored_rows: [],
    errors: [{ line: 7, message: "日付を読めません" }],
    income_total: 0,
    expense_total: 0,
    inserted_amount_total: 0,
    skipped_amount_total: 0,
    suspected_amount_total: 0,
    ...o,
  });
const base = (rows: Row[] = [imp(1)]): Record<string, Row[]> => ({
  statement_imports: rows,
  wallets: [{ id: W1, customer_id: CID, name: "普通預金" }],
  staff_members: [{ user_id: U1, display_name: "担当A" }],
});
const load = (opts: Opts, page = 1) => loadImportHistory(fake(opts).client, CID, page);

describe("loadImportHistory: 顧客の確認", () => {
  it("UUID でない顧客IDは DB を読まずに null（404 扱い）にする", async () => {
    const f = fake({});
    await expect(loadImportHistory(f.client, "not-a-uuid", 1)).resolves.toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it("顧客が見えない（権限外・存在しない＝RLS で空）ときは null を返し、取込記録・口座を一切読まない", async () => {
    const f = fake({ customer: { data: null, error: null }, tables: base() });
    await expect(loadImportHistory(f.client, CID, 1)).resolves.toBeNull();
    expect(f.calls.map((c) => c.table)).toEqual(["customers"]);
  });

  it("顧客の読込エラー・形式不正・別顧客の応答は例外にする（見えない顧客の null にしない）", async () => {
    await expect(load({ customer: { data: null, error: { message: "boom" } } })).rejects.toThrow(/顧客の読込に失敗/);
    await expect(load({ customer: { data: undefined, error: null } })).rejects.toThrow();
    await expect(load({ customer: { data: { id: OTHER, name: "別会社" }, error: null } })).rejects.toThrow(/一致しません/);
  });

  it("不正なページ番号は DB を読む前に拒否する", async () => {
    for (const p of [0, -1, 1.5, IMPORT_MAX_PAGE + 1]) {
      const f = fake({});
      await expect(loadImportHistory(f.client, CID, p)).rejects.toThrow(/ページ番号/);
      expect(f.calls).toHaveLength(0);
    }
  });
});

describe("loadImportHistory: 内容", () => {
  it("成功の取込を、口座名・取込者名・件数・金額・金額0の行つきで返し、顧客を持つ表を customer_id で絞る", async () => {
    const f = fake({ tables: base() });
    const h = await loadImportHistory(f.client, CID, 1);
    expect(h!.customer).toEqual({ id: CID, name: "テスト商事" });
    expect(h!.rows).toHaveLength(1);
    expect(h!.rows[0]).toEqual({
      importId: id(1),
      at: "2026-10-03T05:00:01Z",
      source: "csv",
      status: "completed",
      fileName: "oct.csv",
      csvFormat: "bank_generic",
      wallet: { id: W1, name: "普通預金" },
      importer: { id: U1, name: "担当A" },
      sourceRowCount: 5,
      counts: { read: 4, inserted: 2, skipped: 1, suspected: 1 },
      amounts: { income: 10000, expense: 3000, inserted: 8000, skipped: 2000, suspected: 3000 },
      ignored: { state: "ok", items: [{ line: 5, text: "金額が0" }], total: 1, omitted: 0 },
      errors: { state: "ok", items: [], total: 0, omitted: 0 },
      warnings: [],
    });
    for (const c of f.calls.filter((c) => ["statement_imports", "wallets"].includes(c.table))) {
      expect(c.eq, c.table).toContainEqual(["customer_id", CID]);
    }
    // 取込の記録だけを読む。明細・判断・承認の表は読まない
    expect(new Set(f.calls.map((c) => c.table))).toEqual(new Set(["customers", "statement_imports", "wallets", "staff_members"]));
  });

  it("失敗の取込は、読めなかった行を行番号つきで返し、件数・金額 0 を警告にしない", async () => {
    const h = await load({ tables: base([failedImp(1)]) });
    expect(h!.rows[0]).toMatchObject({
      status: "failed",
      csvFormat: "card_generic",
      sourceRowCount: 20,
      counts: { read: 0, inserted: 0 },
      errors: { state: "ok", items: [{ line: 7, text: "日付を読めません" }], total: 1 },
      warnings: [],
    });
  });

  it("古い記録の欠落（ファイル名・形式・取込者・元の行数）は null のまま返し、0 や空文字にしない", async () => {
    const legacy = imp(1, { file_name: null, csv_format: null, imported_by: null, source_row_count: null, ignored_rows: [] });
    const h = await load({ tables: base([legacy]) });
    expect(h!.rows[0]).toMatchObject({
      fileName: null,
      csvFormat: null,
      importer: { id: null, name: null },
      sourceRowCount: null,
      warnings: [], // 元の行数が不明なら、行数の照合はしない（合っているとも言わない）
    });
  });

  it("口座・取込者の名前が読めなくても取込の行を消さず、名前だけ null にする", async () => {
    const t = base([imp(1, { imported_by: U2 })]);
    t.wallets = [];
    const h = await load({ tables: t });
    expect(h!.rows).toHaveLength(1);
    expect(h!.rows[0]).toMatchObject({ wallet: { id: W1, name: null }, importer: { id: U2, name: null } });
  });

  it("source が freee_wallet_txns の記録も隠さず返す", async () => {
    const h = await load({ tables: base([imp(1, { source: "freee_wallet_txns", csv_format: null })]) });
    expect(h!.rows[0]!.source).toBe("freee_wallet_txns");
  });
});

describe("loadImportHistory: 別顧客", () => {
  it("他の顧客の取込記録・口座が応答に混ざっていたら中止する", async () => {
    await expect(load({ tables: base(), data: { statement_imports: [imp(1, { customer_id: OTHER })] } })).rejects.toThrow(/他の顧客/);
    await expect(load({ tables: base(), data: { wallets: [{ id: W1, customer_id: OTHER, name: "他社口座" }] } })).rejects.toThrow(/他の顧客/);
  });

  it("他の顧客の取込記録は eq で除かれ、一覧に含まれない", async () => {
    const t = base([imp(1), imp(2, { customer_id: OTHER })]);
    const h = await load({ tables: t });
    expect(h!.rows.map((r) => r.importId)).toEqual([id(1)]);
  });
});

describe("loadImportHistory: 照合の警告", () => {
  const warns = async (o: Row) => (await load({ tables: base([imp(1, o)]) }))!.rows[0]!.warnings;

  it("件数・金額・行数が崩れた成功の記録に、それぞれ警告を付ける（黙って正常にしない）", async () => {
    expect(await warns({ inserted_count: 3 })).toEqual([expect.stringContaining("件数が合いません")]);
    expect(await warns({ expense_total: 3001 })).toEqual([expect.stringContaining("金額が合いません")]);
    expect(await warns({ source_row_count: 9 })).toEqual([expect.stringContaining("行数が合いません")]);
  });

  it("失敗の記録なのに件数・金額が0でない、または理由がない場合も警告する", async () => {
    const w = (o: Row) => load({ tables: base([failedImp(1, o)]) }).then((h) => h!.rows[0]!.warnings);
    expect(await w({ inserted_count: 1 })).toEqual([expect.stringContaining("取り込んだ件数")]);
    expect(await w({ income_total: 100 })).toEqual([expect.stringContaining("金額が 0 ではありません")]);
    expect(await w({ errors: [] })).toEqual([expect.stringContaining("理由がありません")]);
  });

  it("金額0の行・読めなかった行の形式が不正なら、空の一覧にせず invalid と警告にする", async () => {
    const h = await load({ tables: base([imp(1, { ignored_rows: "broken", errors: [{ line: "x" }] })]) });
    const r = h!.rows[0]!;
    expect(r.ignored).toEqual({ state: "invalid" });
    expect(r.errors).toEqual({ state: "invalid" });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join()).not.toContain("行数が合いません"); // 数えられないので行数の照合はしない
  });

  it("行番号 0（ファイル全体の誤り）は有効、負数は invalid（空の一覧にしない）", async () => {
    const zero = await load({ tables: base([failedImp(1, { errors: [{ line: 0, message: "見出しがありません" }] })]) });
    expect(zero!.rows[0]!.errors).toMatchObject({ state: "ok", items: [{ line: 0, text: "見出しがありません" }], total: 1 });
    expect(zero!.rows[0]!.warnings).toEqual([]);
    const neg = await load({ tables: base([imp(1, { ignored_rows: [{ line: -1, reason: "x" }], errors: [{ line: -3, message: "y" }] })]) });
    expect(neg!.rows[0]!.ignored).toEqual({ state: "invalid" });
    expect(neg!.rows[0]!.errors).toEqual({ state: "invalid" });
    expect(neg!.rows[0]!.warnings).toHaveLength(2);
  });

  it("大量の金額0の行は先頭 MAX_DETAIL_ITEMS 件だけ返し、省略件数と総数を示す。行数の照合は総数で行う", async () => {
    const many = Array.from({ length: MAX_DETAIL_ITEMS + 50 }, (_, i) => ({ line: i + 2, reason: "金額が0" }));
    const h = await load({ tables: base([imp(1, { ignored_rows: many, source_row_count: 4 + many.length })]) });
    const r = h!.rows[0]!;
    expect(r.ignored).toMatchObject({ state: "ok", total: 150, omitted: 50 });
    expect(r.ignored.state === "ok" && r.ignored.items).toHaveLength(MAX_DETAIL_ITEMS);
    expect(r.warnings).toEqual([]);
  });
});

describe("loadImportHistory: 金額の安全性", () => {
  it("bigint が文字列で返っても、安全な整数なら正確に数値にする", async () => {
    const h = await load({ tables: base([imp(1, { income_total: "10000", expense_total: "3000" })]) });
    expect(h!.rows[0]!.amounts).toMatchObject({ income: 10000, expense: 3000 });
    expect(h!.rows[0]!.warnings).toEqual([]);
  });

  it("安全な整数を超える値（丸められる値）・小数・負数・数字以外は、丸めず例外にする", async () => {
    for (const bad of ["9007199254740993", 9007199254740993, 1.5, -1, "1e3", "abc", null]) {
      await expect(load({ tables: base([imp(1, { income_total: bad })]) }), String(bad)).rejects.toThrow();
    }
    for (const col of ["row_count", "inserted_count", "skipped_duplicate_count", "suspected_duplicate_count", "source_row_count"]) {
      await expect(load({ tables: base([imp(1, { [col]: 2.5 })]) }), col).rejects.toThrow();
    }
  });

  it("各値は安全でも合計が安全な整数を超えるときは、丸めた値で照合せず警告する", async () => {
    const max = Number.MAX_SAFE_INTEGER;
    const h = await load({ tables: base([imp(1, { income_total: max, expense_total: 1, inserted_amount_total: max, skipped_amount_total: 1, suspected_amount_total: 0 })]) });
    expect(h!.rows[0]!.warnings).toEqual([expect.stringContaining("大きすぎて照合できません")]);
  });
});

describe("loadImportHistory: 並び・ページ", () => {
  const many = (n: number) =>
    base(Array.from({ length: n }, (_, i) => imp(i + 1, { imported_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() })));

  it("order は imported_at 降順→id 降順で、range は offset と +1 件を指定する", async () => {
    const f = fake({ tables: base() });
    await loadImportHistory(f.client, CID, 3);
    const c = f.calls.find((x) => x.table === "statement_imports")!;
    expect(c.order).toEqual([
      ["imported_at", false],
      ["id", false],
    ]);
    expect(c.range).toEqual([2 * IMPORT_PAGE_SIZE, 3 * IMPORT_PAGE_SIZE]);
  });

  it("50件ちょうどなら次ページなし、51件なら次ページありで50件だけ返す。2ページ目に最古が出る", async () => {
    const exact = await load({ tables: many(IMPORT_PAGE_SIZE) });
    expect(exact).toMatchObject({ hasNext: false, hasPrevious: false, olderBeyondLimit: false });
    expect(exact!.rows).toHaveLength(IMPORT_PAGE_SIZE);
    const over = await load({ tables: many(IMPORT_PAGE_SIZE + 1) });
    expect(over).toMatchObject({ hasNext: true, hasPrevious: false });
    expect(over!.rows).toHaveLength(IMPORT_PAGE_SIZE);
    expect(over!.rows[0]!.importId).toBe(id(IMPORT_PAGE_SIZE + 1)); // 新しい順
    const second = await load({ tables: many(IMPORT_PAGE_SIZE + 1) }, 2);
    expect(second!.rows.map((r) => r.importId)).toEqual([id(1)]);
    expect(second).toMatchObject({ hasNext: false, hasPrevious: true, page: 2 });
  });

  it("範囲外のページは空で返し、エラーにも次ページありにもしない", async () => {
    expect(await load({ tables: base() }, 5)).toMatchObject({ rows: [], hasNext: false, hasPrevious: true, page: 5 });
  });

  it("同じ時刻の取込は id の降順で並び、ページをまたいでも重複・欠落しない", async () => {
    const total = IMPORT_PAGE_SIZE + 5;
    const t = base(Array.from({ length: total }, (_, i) => imp(i + 1, { imported_at: "2026-10-01T09:00:00Z" })));
    const p1 = await load({ tables: t }, 1);
    const p2 = await load({ tables: t }, 2);
    const ids = [...p1!.rows, ...p2!.rows].map((r) => r.importId);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    expect(ids).toEqual([...ids].sort().reverse());
  });

  it("サーバーの応答上限で行が切れても、必要な件数まで続けて読み、次ページ判定を誤らない", async () => {
    const t = many(IMPORT_PAGE_SIZE + 3);
    const f = fake({ tables: t, cap: 20 });
    const h = await loadImportHistory(f.client, CID, 1);
    expect(h!.rows).toHaveLength(IMPORT_PAGE_SIZE);
    expect(h!.hasNext).toBe(true);
    expect(f.calls.filter((c) => c.table === "statement_imports").length).toBeGreaterThan(1);
    const last = await load({ tables: t, cap: 2 }, 2);
    expect(last!.rows.map((r) => r.importId)).toEqual([id(3), id(2), id(1)]);
    expect(last!.hasNext).toBe(false);
  });

  it("最終ページ（IMPORT_MAX_PAGE）では、より古い記録があっても次ページなしとし、辿れない旨を別に返す", async () => {
    const rows = Array.from({ length: IMPORT_PAGE_SIZE + 1 }, (_, i) => imp(i + 1, { imported_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() }));
    const offset = (IMPORT_MAX_PAGE - 1) * IMPORT_PAGE_SIZE;
    const empty = { wallets: [], staff_members: [] };
    const last = await load({ window: { statement_imports: { base: offset, rows } }, tables: empty }, IMPORT_MAX_PAGE);
    expect(last).toMatchObject({ hasNext: false, hasPrevious: true, olderBeyondLimit: true });
    expect(last!.rows).toHaveLength(IMPORT_PAGE_SIZE);
    // ちょうど最後で終わるなら案内は出さない
    const exact = await load({ window: { statement_imports: { base: offset, rows: rows.slice(0, IMPORT_PAGE_SIZE) } }, tables: empty }, IMPORT_MAX_PAGE);
    expect(exact).toMatchObject({ hasNext: false, olderBeyondLimit: false });
    // 1つ手前は通常どおり次ページあり
    const prev = await load({ window: { statement_imports: { base: offset - IMPORT_PAGE_SIZE, rows } }, tables: empty }, IMPORT_MAX_PAGE - 1);
    expect(prev).toMatchObject({ hasNext: true, olderBeyondLimit: false });
  });
});

describe("loadImportHistory: 読込失敗は空の成功にしない", () => {
  it("読込エラー・null・配列でない応答は、表ごとに例外にする", async () => {
    for (const table of ["statement_imports", "wallets", "staff_members"]) {
      await expect(load({ tables: base(), errors: { [table]: { message: "denied sk-secret" } } }), table).rejects.toThrow(/読込に失敗/);
      await expect(load({ tables: base(), data: { [table]: null } }), table).rejects.toThrow(/読込に失敗/);
    }
  });

  it("形式不正・不明な状態・不明な source・取込IDの重複は例外にする", async () => {
    await expect(load({ data: { statement_imports: [imp(1, { status: "partial" })] } })).rejects.toThrow();
    await expect(load({ data: { statement_imports: [imp(1, { source: "api" })] } })).rejects.toThrow();
    await expect(load({ data: { statement_imports: [{ id: "a" }] } })).rejects.toThrow();
    await expect(load({ data: { statement_imports: [imp(1), imp(1)] } })).rejects.toThrow(/重複/);
  });
});
