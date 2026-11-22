import { describe, expect, it, vi } from "vitest";
import { PAGE_SIZE, fetchAll } from "@/lib/supabase/fetch-all";

/** サーバーが1回に maxRows 行までしか返さない状況をまねる */
function fakeTable(total: number, maxRows: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  return vi.fn(async (from: number, to: number) => ({
    data: rows.slice(from, Math.min(to + 1, from + maxRows)),
    error: null,
  }));
}

describe("fetchAll", () => {
  it("上限（1,000行）を超える行もすべて読む（24か月で月300件の過去仕訳 = 7,200行）", async () => {
    const page = fakeTable(7200, PAGE_SIZE);
    const rows = await fetchAll("過去仕訳", page);
    expect(rows).toHaveLength(7200);
    expect(new Set(rows.map((r) => r.id)).size).toBe(7200);
  });

  it("サーバーの上限が1ページより小さくても漏れない", async () => {
    const rows = await fetchAll("過去仕訳", fakeTable(2500, 300));
    expect(rows).toHaveLength(2500);
  });

  it("読込に失敗したら途中までの行で計算せず、エラーにする", async () => {
    const page = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: 1 }], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "timeout" } });
    await expect(fetchAll("過去仕訳", page)).rejects.toThrow(/過去仕訳の読込に失敗しました: timeout/);
  });

  it("1ページ目が data: null（error もなし）なら空として扱わず、エラーにする", async () => {
    const page = vi.fn().mockResolvedValueOnce({ data: null, error: null });
    await expect(fetchAll("過去仕訳", page)).rejects.toThrow(/過去仕訳の読込に失敗しました/);
  });

  it("2ページ目が data: null なら、1ページ目の行を成功として返さずエラーにする", async () => {
    const page = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: "synthetic-1" }], error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    await expect(fetchAll("過去仕訳", page)).rejects.toThrow(/過去仕訳の読込に失敗しました/);
  });

  it.each([
    ["undefined", undefined],
    ["オブジェクト", { length: 0 } as unknown],
    ["配列に似たオブジェクト", { length: 1, 0: { id: 1 } } as unknown],
    ["文字列", "abc" as unknown],
  ])("data が配列でない応答（%s）はエラーにし、途中までの行を返さない", async (_label, bad) => {
    const page = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: "synthetic-1" }], error: null })
      .mockResolvedValueOnce({ data: bad, error: null });
    await expect(fetchAll("過去仕訳", page)).rejects.toThrow(/過去仕訳の読込に失敗しました/);
  });

  it("空の配列は正常な終端で、それまでに読んだ行を返す", async () => {
    const page = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: 1 }], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    await expect(fetchAll("過去仕訳", page)).resolves.toEqual([{ id: 1 }]);
  });
});
