import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { supabaseStatementImportGateway } from "@/lib/statements/gateway";

const IMPORT_ID = "00000000-0000-4000-8000-000000000001";

const YEN_FIELDS = [
  "income_total",
  "expense_total",
  "inserted_amount_total",
  "skipped_amount_total",
  "suspected_amount_total",
] as const;

const COUNT_FIELDS = ["inserted_count", "skipped_duplicate_count", "suspected_duplicate_count"] as const;

type ResultRow = Record<string, unknown>;

function validRow(): ResultRow {
  return {
    import_id: IMPORT_ID,
    inserted_count: 2,
    skipped_duplicate_count: 1,
    suspected_duplicate_count: 1,
    income_total: 500,
    expense_total: 100,
    inserted_amount_total: 100,
    skipped_amount_total: 300,
    suspected_amount_total: 200,
  };
}

// 基準の応答は 入金 + 出金 = 500 + 100 = 600 = 登録 + 読み飛ばし + 重複の疑い = 100 + 300 + 200 で整合させている。
// 一方、項目ごとの型境界のテストは、1 項目だけを差し替えるため合計が合わなくなる。gateway は金額の照合をしない
// （照合は history.ts の reconcile の役割）ので、それらのテストは照合とは独立に、その項目の型だけを確かめる。

function fakeClient(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(async () => result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const TARGET = {
  customerId: "00000000-0000-4000-8000-0000000000c1",
  walletId: "00000000-0000-4000-8000-0000000000d1",
  fileName: "synthetic.csv",
  formatId: "bank_generic",
  rows: [],
  sourceRowCount: 4,
  ignored: [],
};

async function importWith(data: unknown) {
  const { client, rpc } = fakeClient({ data, error: null });
  const promise = supabaseStatementImportGateway(client).importRows(TARGET);
  return { promise, rpc };
}

function withYen(field: string, value: unknown): ResultRow[] {
  const row = validRow();
  if (value === undefined) delete row[field];
  else row[field] = value;
  return [row];
}

describe("supabaseStatementImportGateway.importRows の結果検証", () => {
  it("正常な応答を従来の形に写し、RPC を決まった引数で 1 回呼ぶ", async () => {
    const { promise, rpc } = await importWith([validRow()]);
    await expect(promise).resolves.toEqual({
      importId: IMPORT_ID,
      insertedCount: 2,
      skippedDuplicateCount: 1,
      suspectedDuplicateCount: 1,
      incomeTotal: 500,
      expenseTotal: 100,
      insertedAmountTotal: 100,
      skippedAmountTotal: 300,
      suspectedAmountTotal: 200,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("import_bank_statement", {
      p_customer_id: TARGET.customerId,
      p_wallet_id: TARGET.walletId,
      p_source: "csv",
      p_file_name: "synthetic.csv",
      p_csv_format: "bank_generic",
      p_rows: [],
      p_source_row_count: 4,
      p_ignored_rows: [],
    });
  });

  describe.each(YEN_FIELDS)("金額 %s", (field) => {
    const key = {
      income_total: "incomeTotal",
      expense_total: "expenseTotal",
      inserted_amount_total: "insertedAmountTotal",
      skipped_amount_total: "skippedAmountTotal",
      suspected_amount_total: "suspectedAmountTotal",
    }[field];

    it.each([
      [0, 0],
      [1, 1],
      [600, 600],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      ["0", 0],
      ["600", 600],
      ["9007199254740991", Number.MAX_SAFE_INTEGER],
    ])("整数 %j（number または数字だけの文字列）は受け入れる", async (input, expected) => {
      const { promise } = await importWith(withYen(field, input));
      const result = await promise;
      expect((result as Record<string, unknown>)[key]).toBe(expected);
    });

    it.each([
      ["null", null],
      ["項目なし", undefined],
      ["空文字", ""],
      ["空白だけ", "   "],
      ["true", true],
      ["false", false],
    ])("欠損・空・真偽値（%s）は 0 円・1 円にせず拒否する", async (_label, input) => {
      const { promise } = await importWith(withYen(field, input));
      await expect(promise).rejects.toThrow();
    });

    it.each([
      ["負の number", -1],
      ["負の文字列", "-1"],
      ["小数の number", 12.5],
      ["小数の文字列", "12.5"],
      ["小数点つきの整数文字列", "1.0"],
      ["安全でない整数の number", Number.MAX_SAFE_INTEGER + 1],
      ["安全でない整数の文字列（丸めで同値になる）", "9007199254740992"],
      ["安全でない整数の文字列（丸めで別値になる）", "9007199254740993"],
    ])("負・小数・安全でない整数（%s）は拒否する", async (_label, input) => {
      const { promise } = await importWith(withYen(field, input));
      await expect(promise).rejects.toThrow();
    });

    it.each([
      ["英字", "abc"],
      ["指数表記", "1e3"],
      ["16進", "0x10"],
      ["前後の空白", " 12 "],
      ["符号つき", "+5"],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["空配列", []],
      ["1要素の配列", [7]],
      ["空オブジェクト", {}],
    ])("数字以外の表現（%s）は拒否する", async (_label, input) => {
      const { promise } = await importWith(withYen(field, input));
      await expect(promise).rejects.toThrow();
    });
  });

  it("5 項目のうち 1 項目だけ壊れていても、ほかを 0 にして成功させず全体を失敗にする", async () => {
    for (const field of YEN_FIELDS) {
      const { promise } = await importWith(withYen(field, null));
      await expect(promise).rejects.toThrow();
    }
  });

  it("5 項目すべてが 0 や数字文字列の正当な応答は成功する", async () => {
    const row = validRow();
    row.income_total = 0;
    row.expense_total = "0";
    row.inserted_amount_total = "0";
    row.skipped_amount_total = 0;
    row.suspected_amount_total = "0";
    const { promise } = await importWith([row]);
    await expect(promise).resolves.toMatchObject({
      incomeTotal: 0,
      expenseTotal: 0,
      insertedAmountTotal: 0,
      skippedAmountTotal: 0,
      suspectedAmountTotal: 0,
    });
  });

  describe("件数・形・エラーは従来どおり", () => {
    it.each([
      ["data が null", null],
      ["data が配列でない", validRow()],
      ["空配列", []],
      ["2 行", [validRow(), validRow()]],
      ["import_id が UUID でない", [{ ...validRow(), import_id: "not-a-uuid" }]],
      ["import_id なし", [{ ...validRow(), import_id: undefined }]],
    ])("%s は拒否する", async (_label, data) => {
      const { promise } = await importWith(data);
      await expect(promise).rejects.toThrow();
    });

    describe.each(COUNT_FIELDS)("件数 %s", (field) => {
      it.each([
        ["null", null],
        ["数字の文字列", "1"],
        ["負", -1],
        ["小数", 1.5],
        ["真偽値", true],
        ["空文字", ""],
      ])("%s は拒否する", async (_label, input) => {
        const { promise } = await importWith([{ ...validRow(), [field]: input }]);
        await expect(promise).rejects.toThrow();
      });

      it("0 は受け入れる", async () => {
        const { promise } = await importWith([{ ...validRow(), [field]: 0 }]);
        await expect(promise).resolves.toBeDefined();
      });
    });

    it("RPC がエラーを返したら、データがあっても従来の文言で失敗する", async () => {
      const { client } = fakeClient({ data: [validRow()], error: { message: "boom" } });
      await expect(supabaseStatementImportGateway(client).importRows(TARGET)).rejects.toThrow(
        "明細の登録に失敗しました: boom",
      );
    });
  });

  describe("recordFailure は従来どおり", () => {
    const failure = {
      customerId: TARGET.customerId,
      walletId: TARGET.walletId,
      fileName: "synthetic.csv",
      formatId: "bank_generic",
      sourceRowCount: 2,
      errors: [{ line: 1, message: "架空のエラー" }],
    };

    it("UUID を返したらそれを返す", async () => {
      const { client, rpc } = fakeClient({ data: IMPORT_ID, error: null });
      await expect(supabaseStatementImportGateway(client).recordFailure(failure)).resolves.toBe(IMPORT_ID);
      expect(rpc).toHaveBeenCalledWith("record_failed_statement_import", expect.objectContaining({ p_errors: failure.errors }));
    });

    it("UUID でない値は拒否する", async () => {
      const { client } = fakeClient({ data: "nope", error: null });
      await expect(supabaseStatementImportGateway(client).recordFailure(failure)).rejects.toThrow();
    });

    it("RPC エラーは従来の文言で失敗する", async () => {
      const { client } = fakeClient({ data: null, error: { message: "boom" } });
      await expect(supabaseStatementImportGateway(client).recordFailure(failure)).rejects.toThrow(
        "取込の失敗を記録できませんでした: boom",
      );
    });
  });
});
