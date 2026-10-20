import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { StatementImportGateway } from "./import";

const resultSchema = z
  .array(
    z.object({
      import_id: z.string().uuid(),
      inserted_count: z.number().int(),
      skipped_duplicate_count: z.number().int(),
    }),
  )
  .length(1);

/** import_bank_statement を担当者の権限（RLS あり）で呼ぶ */
export function supabaseStatementImportGateway(client: SupabaseClient): StatementImportGateway {
  return async ({ customerId, walletId, fileName, formatId, rows }) => {
    const { data, error } = await client.rpc("import_bank_statement", {
      p_customer_id: customerId,
      p_wallet_id: walletId,
      p_source: "csv",
      p_file_name: fileName,
      p_csv_format: formatId,
      p_rows: rows,
    });
    if (error) throw new Error(`明細の登録に失敗しました: ${error.message}`);
    const [row] = resultSchema.parse(data);
    return {
      importId: row!.import_id,
      insertedCount: row!.inserted_count,
      skippedDuplicateCount: row!.skipped_duplicate_count,
    };
  };
}
