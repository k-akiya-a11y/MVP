import { findStatementFormat, type WalletKind } from "./formats";
import {
  buildDedupeKeys,
  decodeStatement,
  parseStatementCsv,
  type StatementIgnoredRow,
  type StatementParseError,
} from "./parse";

export type StatementImportRow = {
  txn_date: string;
  amount: number;
  direction: "income" | "expense";
  description: string;
  balance: number | null;
  dedupe_key: string;
};

const WALLET_KIND_LABELS: Record<WalletKind, string> = { bank_account: "銀行", credit_card: "クレジットカード", wallet: "現金・その他" };

type ImportTarget = { customerId: string; walletId: string; fileName: string; formatId: string };

/**
 * 取込の件数と金額（円）。skipped は取込全体が同じ内容の再実行だと DB が確かめた、残高のある取込済みの行（読み飛ばし）、
 * suspected は取込済みの行と同じキーで、同一取引と言い切れず「重複の疑い」として確認に回した行。
 * 読めた行 = inserted + skipped + suspected が件数・金額の両方で成り立つ（DB の制約でも確かめる）。
 */
export type ImportCounts = {
  importId: string;
  insertedCount: number;
  skippedDuplicateCount: number;
  suspectedDuplicateCount: number;
  ignoredCount: number;
  incomeTotal: number;
  expenseTotal: number;
  insertedAmountTotal: number;
  skippedAmountTotal: number;
  suspectedAmountTotal: number;
};

/** DB への登録（import_bank_statement・record_failed_statement_import）。テストではモックに差し替える */
export type StatementImportGateway = {
  importRows(
    args: ImportTarget & { rows: StatementImportRow[]; sourceRowCount: number; ignored: StatementIgnoredRow[] },
  ): Promise<Omit<ImportCounts, "ignoredCount">>;
  /** 取り込まなかったファイルも、理由と行番号を取込記録に残す */
  recordFailure(args: ImportTarget & { sourceRowCount: number | null; errors: StatementParseError[] }): Promise<string>;
};

export type ImportStatementResult =
  | ({ ok: true } & ImportCounts)
  | { ok: false; errors: StatementParseError[]; failureRecordId: string | null };

/**
 * 明細 CSV を取り込む。1行でも読めない行があればファイル全体を取り込まず、失敗として記録する
 * （一部だけ取り込むと、取込漏れの明細に気づけなくなるため）。
 */
export async function importStatementCsv(
  input: ImportTarget & { bytes: Uint8Array; walletKind: WalletKind },
  gateway: StatementImportGateway,
): Promise<ImportStatementResult> {
  const { bytes, walletKind, ...target } = input;
  const fail = async (errors: StatementParseError[], sourceRowCount: number | null): Promise<ImportStatementResult> => {
    // 未対応の形式は取込記録の csv_format に入れられないので、記録せずに返す
    const failureRecordId = findStatementFormat(target.formatId)
      ? await gateway.recordFailure({ ...target, sourceRowCount, errors })
      : null;
    return { ok: false, errors, failureRecordId };
  };

  const format = findStatementFormat(target.formatId);
  if (!format) {
    return fail([{ line: 0, message: `未対応の CSV 形式です: ${target.formatId}` }], null);
  }
  // 取込済みかどうかは口座ごとに判定するので、口座を取り違えると同じ明細が別の口座に二重に登録される
  if (format.walletKind !== walletKind) {
    return fail([{ line: 0, message: `選んだ口座と CSV の形式が合っていません（${format.label} の形式は${WALLET_KIND_LABELS[format.walletKind]}の口座にだけ取り込めます）` }], null);
  }
  let text: string;
  try {
    text = decodeStatement(bytes, format.encoding);
  } catch {
    return fail([{ line: 0, message: `文字コードを読めません（${format.encoding} を想定）` }], null);
  }
  const parsed = parseStatementCsv(text, format);
  // 書式の誤り・読めない行が1つでもあれば、1件も登録せずファイル全体を失敗として記録する
  if (parsed.errors.length > 0) {
    return fail(parsed.errors, parsed.sourceRowCount);
  }
  const sourceRowCount = parsed.sourceRowCount;
  if (sourceRowCount === null) {
    // 行数を数えられるのは書式の誤りがないときだけ。ここには来ない想定だが、来たら取り込まない
    return fail([{ line: 0, message: "CSV の行数を数えられません" }], null);
  }
  if (parsed.rows.length === 0) {
    return fail([{ line: 0, message: "取引の行がありません" }], sourceRowCount);
  }
  const keys = buildDedupeKeys(target.walletId, parsed.rows);
  const rows: StatementImportRow[] = parsed.rows.map((row, i) => ({
    txn_date: row.txnDate,
    amount: row.amount,
    direction: row.direction,
    description: row.description,
    balance: row.balance,
    dedupe_key: keys[i]!,
  }));
  const result = await gateway.importRows({
    ...target,
    formatId: format.id,
    rows,
    sourceRowCount,
    ignored: parsed.ignored,
  });
  return { ok: true, ...result, ignoredCount: parsed.ignored.length };
}
