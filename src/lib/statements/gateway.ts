import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { StatementImportGateway } from "./import";

const count = z.number().int().nonnegative();
// bigint の金額は supabase-js では number で返る
const yen = z.coerce.number().int().nonnegative();

const resultSchema = z
  .array(
    z.object({
      import_id: z.string().uuid(),
      inserted_count: count,
      skipped_duplicate_count: count,
      suspected_duplicate_count: count,
      income_total: yen,
      expense_total: yen,
      inserted_amount_total: yen,
      skipped_amount_total: yen,
      suspected_amount_total: yen,
    }),
  )
  .length(1);

/** import_bank_statement・record_failed_statement_import を担当者の権限（RLS あり）で呼ぶ */
export function supabaseStatementImportGateway(client: SupabaseClient): StatementImportGateway {
  return {
    async importRows({ customerId, walletId, fileName, formatId, rows, sourceRowCount, ignored }) {
      const { data, error } = await client.rpc("import_bank_statement", {
        p_customer_id: customerId,
        p_wallet_id: walletId,
        p_source: "csv",
        p_file_name: fileName,
        p_csv_format: formatId,
        p_rows: rows,
        p_source_row_count: sourceRowCount,
        p_ignored_rows: ignored,
      });
      if (error) throw new Error(`明細の登録に失敗しました: ${error.message}`);
      const [row] = resultSchema.parse(data);
      return {
        importId: row!.import_id,
        insertedCount: row!.inserted_count,
        skippedDuplicateCount: row!.skipped_duplicate_count,
        suspectedDuplicateCount: row!.suspected_duplicate_count,
        incomeTotal: row!.income_total,
        expenseTotal: row!.expense_total,
        insertedAmountTotal: row!.inserted_amount_total,
        skippedAmountTotal: row!.skipped_amount_total,
        suspectedAmountTotal: row!.suspected_amount_total,
      };
    },

    async recordFailure({ customerId, walletId, fileName, formatId, sourceRowCount, errors }) {
      const { data, error } = await client.rpc("record_failed_statement_import", {
        p_customer_id: customerId,
        p_wallet_id: walletId,
        p_source: "csv",
        p_file_name: fileName,
        p_csv_format: formatId,
        p_source_row_count: sourceRowCount,
        p_errors: errors,
      });
      if (error) throw new Error(`取込の失敗を記録できませんでした: ${error.message}`);
      return z.string().uuid().parse(data);
    },
  };
}
