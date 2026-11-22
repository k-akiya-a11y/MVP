import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { JournalAi } from "@/lib/ai/client";
import { JOURNAL_MODEL, JOURNAL_PROMPT_VERSION } from "@/lib/ai/version";
import { runProposalJob } from "@/lib/proposals/run";
import { shiftYears, supabaseProposalStore } from "@/lib/proposals/store";

describe("shiftYears（過去仕訳の遡り開始日）", () => {
  it("うるう日を平年へ遡ると、移動先の月末日に丸める", () => {
    expect(shiftYears("2028-02-29", -2)).toBe("2026-02-28");
  });

  it("うるう日からうるう年へ遡るときは 2/29 のまま", () => {
    expect(shiftYears("2028-02-29", -4)).toBe("2024-02-29");
  });

  it("通常の日付は日をそのまま保つ", () => {
    expect(shiftYears("2026-10-24", -2)).toBe("2024-10-24");
    expect(shiftYears("2026-03-31", -2)).toBe("2024-03-31");
    expect(shiftYears("2026-02-28", -2)).toBe("2024-02-28");
  });

  it("1月1日・12月31日でも年だけが変わる", () => {
    expect(shiftYears("2026-01-01", -2)).toBe("2024-01-01");
    expect(shiftYears("2026-12-31", -2)).toBe("2024-12-31");
  });

  it("世紀年の平年（2100 年）も 2/28 に丸める", () => {
    expect(shiftYears("2104-02-29", -4)).toBe("2100-02-28");
  });
});

describe("supabaseProposalStore.loadCustomerContext", () => {
  it("うるう日の基準日でも、過去仕訳の検索に実在する日付を渡す", async () => {
    const gteCalls: Array<[string, string]> = [];
    const lteCalls: Array<[string, string]> = [];
    const customer = {
      id: "c1",
      name: "テスト顧客",
      tax_method: "general",
      invoice_registered: true,
      low_confidence_amount_threshold: 300000,
    };
    // 流れるように繋ぐクエリビルダーの代用。await されると表ごとの結果を返す
    const client = {
      from(table: string) {
        const result = { data: table === "customers" ? customer : [], error: null };
        const builder: Record<string, unknown> = {
          then: (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve),
        };
        for (const method of ["select", "eq", "order", "range", "single"]) builder[method] = () => builder;
        builder.gte = (column: string, value: string) => {
          gteCalls.push([column, value]);
          return builder;
        };
        builder.lte = (column: string, value: string) => {
          lteCalls.push([column, value]);
          return builder;
        };
        return builder;
      },
    } as unknown as SupabaseClient;

    await supabaseProposalStore(client).loadCustomerContext("c1", "2028-02-29");

    expect(gteCalls).toEqual([["entry_date", "2026-02-28"]]);
    expect(lteCalls).toEqual([["entry_date", "2028-02-29"]]);
  });
});

describe("supabaseProposalStore.loadCustomerContext の過去仕訳の範囲 [shiftYears(基準日, -2), 基準日]", () => {
  type PastRow = { id: string; customer_id: string; entry_date: string };
  type PastQuery = { filters: Array<[string, string, string]>; range: [number, number] | null };

  const customer = {
    id: "c1",
    name: "テスト顧客",
    tax_method: "general",
    invoice_registered: true,
    low_confidence_amount_threshold: 300000,
  };

  const pastRow = (r: PastRow) => ({
    ...r,
    amount: 1000,
    direction: "expense",
    bank_description: null,
    partner_key: null,
    account_item_id: 1,
    tax_code: 1,
    partner_id: null,
    item_id: null,
    section_id: null,
    tag_ids: [],
    description: null,
  });

  /** past_journal_entries だけ、eq / gte / lte / order / range を実際の行に適用して返すクエリビルダーの代用 */
  function clientWith(rows: PastRow[]) {
    const queries: PastQuery[] = [];
    const client = {
      from(table: string) {
        const isPast = table === "past_journal_entries";
        const query: PastQuery = { filters: [], range: null };
        let ordered = false;
        if (isPast) queries.push(query);
        const run = () => {
          if (table === "customers") return { data: customer, error: null };
          if (!isPast) return { data: [], error: null };
          let out = rows.filter((r) =>
            query.filters.every(([op, column, value]) => {
              const actual = r[column as keyof PastRow];
              if (op === "eq") return actual === value;
              if (op === "gte") return actual >= value;
              if (op === "lte") return actual <= value;
              return false;
            }),
          );
          if (ordered) out = [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          if (query.range) out = out.slice(query.range[0], query.range[1] + 1);
          return { data: out.map(pastRow), error: null };
        };
        const builder: Record<string, unknown> = {
          then: (resolve: (v: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve),
        };
        for (const method of ["select", "single"]) builder[method] = () => builder;
        builder.order = () => {
          ordered = true;
          return builder;
        };
        for (const op of ["eq", "gte", "lte"]) {
          builder[op] = (column: string, value: string) => {
            query.filters.push([op, column, value]);
            return builder;
          };
        }
        builder.range = (from: number, to: number) => {
          query.range = [from, to];
          return builder;
        };
        return builder;
      },
    } as unknown as SupabaseClient;
    return { client, queries };
  }

  const loadIds = async (rows: PastRow[], onDate: string) => {
    const { client, queries } = clientWith(rows);
    const ctx = await supabaseProposalStore(client).loadCustomerContext("c1", onDate);
    return { ids: ctx.pastEntries.map((p) => p.id), queries };
  };

  it("下限より前と基準日より後の行を除き、下限の日と基準日当日を含める", async () => {
    const { ids } = await loadIds(
      [
        { id: "too-old", customer_id: "c1", entry_date: "2024-11-04" },
        { id: "lower-day", customer_id: "c1", entry_date: "2024-11-05" },
        { id: "inside", customer_id: "c1", entry_date: "2025-06-15" },
        { id: "on-date", customer_id: "c1", entry_date: "2026-11-05" },
        { id: "future", customer_id: "c1", entry_date: "2026-11-06" },
      ],
      "2026-11-05",
    );

    expect(ids).toEqual(["inside", "lower-day", "on-date"]);
  });

  it("うるう日の基準日でも、丸めた下限の日と基準日当日を含め、その前後は除く", async () => {
    const { ids } = await loadIds(
      [
        { id: "before-lower", customer_id: "c1", entry_date: "2026-02-27" },
        { id: "lower-day", customer_id: "c1", entry_date: "2026-02-28" },
        { id: "on-date", customer_id: "c1", entry_date: "2028-02-29" },
        { id: "after-upper", customer_id: "c1", entry_date: "2028-03-01" },
      ],
      "2028-02-29",
    );

    expect(ids).toEqual(["lower-day", "on-date"]);
  });

  it("別の顧客の行は、日付が範囲内でも含めない", async () => {
    const { ids } = await loadIds(
      [
        { id: "mine", customer_id: "c1", entry_date: "2026-01-10" },
        { id: "other", customer_id: "c2", entry_date: "2026-01-10" },
      ],
      "2026-11-05",
    );

    expect(ids).toEqual(["mine"]);
  });

  it("過去仕訳がない顧客は、空の結果になる", async () => {
    const { ids, queries } = await loadIds([], "2026-11-05");

    expect(ids).toEqual([]);
    expect(queries.map((q) => q.range)).toEqual([[0, 999]]);
  });

  it("範囲内の行がなく、基準日より後の行だけなら、空の結果になる", async () => {
    const { ids } = await loadIds(
      [
        { id: "future-1", customer_id: "c1", entry_date: "2026-11-06" },
        { id: "future-2", customer_id: "c1", entry_date: "2027-03-01" },
      ],
      "2026-11-05",
    );

    expect(ids).toEqual([]);
  });

  it("ページ分割の全ページで、顧客・下限・上限の条件を保って範囲内の全行を読む", async () => {
    // 範囲内 1,100 行（PAGE_SIZE 1,000 を超えて 2 ページに分かれる）＋範囲外・別顧客の行
    const inRange: PastRow[] = Array.from({ length: 1100 }, (_, i) => ({
      id: `in-${String(i).padStart(4, "0")}`,
      customer_id: "c1",
      entry_date: i % 2 === 0 ? "2024-11-05" : "2026-11-05",
    }));
    const noise: PastRow[] = [
      { id: "a-too-old", customer_id: "c1", entry_date: "2024-11-04" },
      { id: "z-future", customer_id: "c1", entry_date: "2026-11-06" },
      { id: "m-other", customer_id: "c2", entry_date: "2025-06-15" },
    ];

    const { ids, queries } = await loadIds([...noise, ...inRange], "2026-11-05");

    expect(ids).toEqual(inRange.map((r) => r.id));
    // 1,000 行 → 100 行 → 空（終端）の 3 ページ。fetchAll の開始位置は「それまでに集めた行数 rows.length」なので、
    // 3 ページ目は 1,100 行を集めた後の [1100, 2099]（ページ番号 × PAGE_SIZE の [2000, 2999] ではない）
    expect(queries.map((q) => q.range)).toEqual([
      [0, 999],
      [1000, 1999],
      [1100, 2099],
    ]);
    for (const q of queries) {
      expect(q.filters).toEqual(
        expect.arrayContaining([
          ["eq", "customer_id", "c1"],
          ["gte", "entry_date", "2024-11-05"],
          ["lte", "entry_date", "2026-11-05"],
        ]),
      );
    }
  });
});

describe("マスタの attrs.fixed_asset の検証（実際の supabaseProposalStore と runProposalJob を通す）", () => {
  const TXN_ID = "40000000-0000-4000-8000-000000000001";
  const DECISION_ID = "50000000-0000-4000-8000-000000000001";
  const customer = {
    id: "c1",
    name: "テスト顧客",
    tax_method: "general",
    invoice_registered: true,
    low_confidence_amount_threshold: 300000,
  };
  const txnRow = {
    id: TXN_ID,
    customer_id: "c1",
    wallet_id: "w1",
    txn_date: "2026-11-05",
    amount: 1000,
    direction: "expense",
    description: "テスト商店",
  };
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdMicros: 1 };

  /** 科目 108 の attrs だけを差し替えたマスタ行（kind / freee_id / name は検証済みの正常値） */
  const masters = (attrs: unknown) => [
    { kind: "account_item", freee_id: 108, name: "工具器具備品", attrs },
    { kind: "tax", freee_id: 21, name: "課対仕入10%", attrs: {} },
  ];

  /** from() は表ごとの行を返し、rpc() は呼出しを記録する。ルール・過去仕訳は空なので、明細は AI に回る */
  function setup(attrs: unknown) {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let claimed = false;
    const tables: Record<string, unknown> = { customers: customer, freee_masters: masters(attrs) };
    const client = {
      from(table: string) {
        // fetchAll は空ページまで読むので、range の [from, to] を配列に実際に適用して終端させる。customers は単一オブジェクトのまま
        let range: [number, number] | null = null;
        const run = () => {
          const source = table in tables ? tables[table] : [];
          if (!Array.isArray(source)) return { data: source, error: null };
          return { data: range ? source.slice(range[0], range[1] + 1) : source, error: null };
        };
        const builder: Record<string, unknown> = {
          then: (resolve: (v: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve),
        };
        for (const method of ["select", "eq", "order", "single", "gte", "lte"]) builder[method] = () => builder;
        builder.range = (from: number, to: number) => {
          range = [from, to];
          return builder;
        };
        return builder;
      },
      async rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        if (name === "claim_pending_proposal_batch") {
          const data = claimed ? [] : [txnRow];
          claimed = true;
          return { data, error: null };
        }
        if (name === "renew_proposal_claim") return { data: true, error: null };
        if (name === "record_claimed_ai_decision") return { data: DECISION_ID, error: null };
        return { data: null, error: null };
      },
    } as unknown as SupabaseClient;
    const ai = vi.fn(async () => ({
      status: "ok",
      output: {
        decision: "proposal",
        account_item_id: 108,
        tax_code: 21,
        partner_id: null,
        item_id: null,
        section_id: null,
        tag_ids: [],
        description: "備品",
        reason: "テスト",
        unknowns: [],
        fixed_asset_possible: false,
        officer_or_personal: false,
      },
      model: JOURNAL_MODEL,
      promptVersion: JOURNAL_PROMPT_VERSION,
      usage,
    })) as unknown as JournalAi & ReturnType<typeof vi.fn>;
    const calls = (name: string) => rpcCalls.filter((c) => c.name === name);
    return { client, ai, calls };
  }

  const load = (attrs: unknown) => supabaseProposalStore(setup(attrs).client).loadCustomerContext("c1", "2026-11-05");

  const MALFORMED: Array<[string, unknown]> = [
    ['文字列 "true"', "true"],
    ['文字列 "false"', "false"],
    ["空文字列", ""],
    ["数値 1", 1],
    ["数値 0", 0],
    ["null", null],
    ["オブジェクト", {}],
    ["配列", []],
  ];

  describe("loadCustomerContext", () => {
    it.each(MALFORMED)("fixed_asset が %s なら、項目名つきのエラーで拒否する", async (_label, value) => {
      await expect(load({ fixed_asset: value })).rejects.toThrow(/fixed_asset/);
    });

    it("不正な fixed_asset は、ほかの正常な attrs と並んでいても拒否する", async () => {
      await expect(load({ default_tax_code: 21, other: "x", fixed_asset: "true" })).rejects.toThrow(/fixed_asset/);
    });

    it("fixed_asset が true なら fixedAsset: true に写す", async () => {
      const ctx = await load({ fixed_asset: true });
      expect(ctx.masters.find((m) => m.id === 108)?.fixedAsset).toBe(true);
    });

    it("fixed_asset が false、または存在しないなら fixedAsset: false に写す", async () => {
      for (const attrs of [{ fixed_asset: false }, {}]) {
        const ctx = await load(attrs);
        expect(ctx.masters.find((m) => m.id === 108)?.fixedAsset).toBe(false);
      }
    });

    it("fixed_asset 以外の attrs は検証せず受け入れる（default_tax_code の扱いも従来どおり）", async () => {
      const ctx = await load({ default_tax_code: "21", unrelated: [1, null, { a: 1 }], note: null });
      const account = ctx.masters.find((m) => m.id === 108);
      expect(account?.fixedAsset).toBe(false);
      expect(account?.defaultTaxCode).toBeUndefined();
    });
  });

  describe("runProposalJob", () => {
    const run = (attrs: unknown) => {
      const s = setup(attrs);
      const result = runProposalJob({ store: supabaseProposalStore(s.client, "owner-1"), ai: s.ai, today: "2026-11-05" });
      return { ...s, result };
    };
    type Breakdown = { forcedLow: string[] };
    const recorded = (calls: ReturnType<typeof setup>["calls"]) => {
      const row = calls("record_claimed_ai_decision")[0]?.args.p_decision as { confidence_breakdown: Breakdown } | undefined;
      return row?.confidence_breakdown.forcedLow;
    };

    it("fixed_asset: true の科目の案は、確信度「低」を強制する理由を持つ", async () => {
      const { result, ai, calls } = run({ fixed_asset: true });
      expect(await result).toMatchObject({ processed: 1, failures: [] });
      expect(ai).toHaveBeenCalledTimes(1);
      expect(recorded(calls)).toContain("固定資産になり得る");
    });

    it.each([["false", { fixed_asset: false }], ["存在しない", {}]])("fixed_asset が %s なら、固定資産を理由に強制「低」にしない（従来どおり）", async (_label, attrs) => {
      const { result, ai, calls } = run(attrs);
      expect(await result).toMatchObject({ processed: 1, failures: [] });
      expect(ai).toHaveBeenCalledTimes(1);
      expect(recorded(calls)).toEqual([]);
    });

    it.each(MALFORMED)("fixed_asset が %s なら、AI も記録も行わず失敗として数え、貸出しを返す", async (_label, value) => {
      const { result, ai, calls } = run({ fixed_asset: value });
      const out = await result;

      expect(out.processed).toBe(0);
      expect(out.attempted).toBe(1);
      expect(out.failures).toHaveLength(1);
      expect(out.failures[0]).toMatchObject({ bankTransactionId: TXN_ID });
      expect(out.failures[0]?.error).toMatch(/fixed_asset/);
      expect(ai).not.toHaveBeenCalled();
      expect(calls("renew_proposal_claim")).toHaveLength(0);
      expect(calls("record_claimed_ai_decision")).toHaveLength(0);
      expect(calls("release_proposal_claims")).toEqual([
        { name: "release_proposal_claims", args: { p_owner: "owner-1", p_ids: [TXN_ID] } },
      ]);
    });
  });
});
