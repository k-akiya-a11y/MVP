import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
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
        return builder;
      },
    } as unknown as SupabaseClient;

    await supabaseProposalStore(client).loadCustomerContext("c1", "2028-02-29");

    expect(gteCalls).toEqual([["entry_date", "2026-02-28"]]);
  });
});
