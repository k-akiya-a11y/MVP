import { findStatementFormat } from "./formats";
import { buildDedupeKeys, decodeStatement, parseStatementCsv, type StatementParseError } from "./parse";

export type StatementImportRow = {
  txn_date: string;
  amount: number;
  direction: "income" | "expense";
  description: string;
  balance: number | null;
  dedupe_key: string;
};

/** DB への登録（import_bank_statement）。テストではモックに差し替える */
export type StatementImportGateway = (args: {
  customerId: string;
  walletId: string;
  fileName: string;
  formatId: string;
  rows: StatementImportRow[];
}) => Promise<ImportCounts>;

/**
 * 取込の件数。skipped は残高まで一致した取込済みの行（読み飛ばし）、
 * suspected は取込済みの行と区別できず「重複の疑い」として確認に回した行。
 */
export type ImportCounts = {
  importId: string;
  insertedCount: number;
  skippedDuplicateCount: number;
  suspectedDuplicateCount: number;
};

export type ImportStatementResult =
  | ({ ok: true } & ImportCounts)
  | { ok: false; errors: StatementParseError[] };

/**
 * 明細 CSV を取り込む。1行でも読めない行があればファイル全体を取り込まない
 * （一部だけ取り込むと、取込漏れの明細に気づけなくなるため）。
 */
export async function importStatementCsv(
  input: { customerId: string; walletId: string; fileName: string; formatId: string; bytes: Uint8Array },
  gateway: StatementImportGateway,
): Promise<ImportStatementResult> {
  const format = findStatementFormat(input.formatId);
  if (!format) {
    return { ok: false, errors: [{ line: 0, message: `未対応の CSV 形式です: ${input.formatId}` }] };
  }
  let text: string;
  try {
    text = decodeStatement(input.bytes, format.encoding);
  } catch {
    return {
      ok: false,
      errors: [{ line: 0, message: `文字コードを読めません（${format.encoding} を想定）` }],
    };
  }
  const parsed = parseStatementCsv(text, format);
  if (parsed.errors.length > 0) {
    return { ok: false, errors: parsed.errors };
  }
  if (parsed.rows.length === 0) {
    return { ok: false, errors: [{ line: 0, message: "取引の行がありません" }] };
  }
  const keys = buildDedupeKeys(input.walletId, parsed.rows);
  const rows: StatementImportRow[] = parsed.rows.map((row, i) => ({
    txn_date: row.txnDate,
    amount: row.amount,
    direction: row.direction,
    description: row.description,
    balance: row.balance,
    dedupe_key: keys[i]!,
  }));
  const result = await gateway({
    customerId: input.customerId,
    walletId: input.walletId,
    fileName: input.fileName,
    formatId: format.id,
    rows,
  });
  return { ok: true, ...result };
}
