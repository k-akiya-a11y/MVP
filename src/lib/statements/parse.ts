import { createHash } from "node:crypto";
import { CsvSyntaxError, parseCsvWithLines, type CsvRow } from "./csv";
import type { StatementCsvFormat } from "./formats";
import { parseStatementDate, parseYen } from "./values";

export type Direction = "income" | "expense";

export type ParsedStatementRow = {
  /** CSV 上の行番号（1始まり、見出し行を含む） */
  line: number;
  txnDate: string;
  amount: number;
  direction: Direction;
  description: string;
  balance: number | null;
};

export type StatementParseError = { line: number; message: string };

/** 取引として扱わなかった行（金額0の残高照会など）。捨てずに行番号と理由を取込記録に残す */
export type StatementIgnoredRow = { line: number; reason: string };

export type StatementParseResult = {
  rows: ParsedStatementRow[];
  errors: StatementParseError[];
  ignored: StatementIgnoredRow[];
  /**
   * 見出し行より後の行数（空行を除く）。= rows + ignored + errors（照合に使う）。
   * CSV の形式が壊れていて行を数えられないときは null（取込記録には行数なしの失敗として残す）
   */
  sourceRowCount: number | null;
};

export function decodeStatement(bytes: Uint8Array, encoding: StatementCsvFormat["encoding"]): string {
  // UTF-8 の BOM があれば形式の指定より優先する（ネットバンキングによっては UTF-8 で出す）
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    // 不正なバイトを U+FFFD に置き換えると摘要が変わり、照合・重複判定が狂うため、BOM 後も fatal で読む
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3));
  }
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

function normalizeHeader(s: string): string {
  return s.normalize("NFKC").replace(/\s/g, "");
}

/** 見出し行を探す（先頭10行のうち、日付と摘要の列がそろう最初の行） */
function locateHeader(table: string[][], format: StatementCsvFormat) {
  for (let i = 0; i < Math.min(table.length, 10); i++) {
    const headers = (table[i] ?? []).map(normalizeHeader);
    const find = (candidates?: string[]) => {
      if (!candidates) return -1;
      for (const c of candidates) {
        const idx = headers.indexOf(normalizeHeader(c));
        if (idx >= 0) return idx;
      }
      return -1;
    };
    const date = find(format.columns.date);
    const description = find(format.columns.description);
    if (date < 0 || description < 0) continue;
    return {
      headerIndex: i,
      date,
      description,
      withdrawal: find(format.columns.withdrawal),
      deposit: find(format.columns.deposit),
      signedAmount: find(format.columns.signedAmount),
      balance: find(format.columns.balance),
    };
  }
  return null;
}

/**
 * 明細 CSV を読み、取引の行に変換する。読めない行は errors に入れる（取込側は1行でもあればファイル全体を取り込まない）。
 * 金額0の行（残高照会の行など）は取引にせず、ignored に行番号と理由を残す。
 * CSV の書式そのものが壊れているとき（クオートが閉じていない等）は、どこまでが1行か判断できないので、
 * 行を1件も返さず、誤りの行番号だけを errors に入れる。
 */
export function parseStatementCsv(text: string, format: StatementCsvFormat): StatementParseResult {
  let csvRows: CsvRow[];
  try {
    csvRows = parseCsvWithLines(text);
  } catch (error) {
    if (error instanceof CsvSyntaxError) {
      return {
        rows: [],
        errors: [{ line: error.line, message: `CSV の書式が正しくありません: ${error.message}` }],
        ignored: [],
        sourceRowCount: null,
      };
    }
    throw error;
  }
  const table = csvRows.map((r) => r.cells);
  const header = locateHeader(table, format);
  if (!header) {
    return {
      rows: [],
      errors: [{ line: 1, message: `見出し行が見つかりません（形式: ${format.label}）` }],
      ignored: [],
      sourceRowCount: countDataRows(table, 0),
    };
  }
  const hasSplitColumns = header.withdrawal >= 0 || header.deposit >= 0;
  if (!hasSplitColumns && header.signedAmount < 0) {
    return {
      rows: [],
      errors: [{ line: csvRows[header.headerIndex]!.line, message: "金額の列が見つかりません" }],
      ignored: [],
      sourceRowCount: countDataRows(table, header.headerIndex + 1),
    };
  }

  const rows: ParsedStatementRow[] = [];
  const errors: StatementParseError[] = [];
  const ignored: StatementIgnoredRow[] = [];
  const cell = (r: string[], idx: number) => (idx >= 0 ? (r[idx] ?? "") : "");
  // 行の形（列数）の検査に使う。使う列がすべて行にあること、見出しより右に値がないこと
  const headerWidth = table[header.headerIndex]!.length;
  const requiredWidth = Math.max(header.date, header.description, header.withdrawal, header.deposit, header.signedAmount, header.balance) + 1;

  for (let i = header.headerIndex + 1; i < table.length; i++) {
    const r = table[i]!;
    const line = csvRows[i]!.line;
    try {
      // 値の解釈（金額0の扱いを含む）より先に、行の形を確かめる。途中で切れた行の欠けた列を
      // 空欄 = 金額0として読み飛ばしたり、摘要のカンマで右にずれた列を取り込んだりしないため
      if (r.length < requiredWidth) {
        throw new Error(`列が足りません（${r.length}列、必要なのは${requiredWidth}列以上。行が途中で切れている可能性があります）`);
      }
      if (r.slice(headerWidth).some((c) => c.trim() !== "")) {
        throw new Error(`見出しより右に値があります（${r.length}列、見出しは${headerWidth}列。クオートされていないカンマの可能性があります）`);
      }
      const txnDate = parseStatementDate(cell(r, header.date));
      const description = cell(r, header.description).trim();
      let signed: number; // 正 = 出金
      if (hasSplitColumns) {
        const out = parseYen(cell(r, header.withdrawal)) ?? 0;
        const inn = parseYen(cell(r, header.deposit)) ?? 0;
        if (out !== 0 && inn !== 0) {
          throw new Error("出金と入金の両方に金額があります");
        }
        signed = out !== 0 ? out : -inn;
      } else {
        signed = parseYen(cell(r, header.signedAmount)) ?? 0;
      }
      if (signed === 0) {
        ignored.push({ line, reason: "金額が0（残高照会などの行）" });
        continue;
      }
      if (description === "") {
        throw new Error("摘要が空欄です");
      }
      rows.push({
        line,
        txnDate,
        amount: Math.abs(signed),
        direction: signed > 0 ? "expense" : "income",
        description,
        balance: parseYen(cell(r, header.balance)),
      });
    } catch (error) {
      errors.push({ line, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { rows, errors, ignored, sourceRowCount: rows.length + errors.length + ignored.length };
}

/** 見出し行より後の、空でない行の数 */
function countDataRows(table: string[][], from: number): number {
  return table.slice(from).filter((r) => r.some((c) => c.trim() !== "")).length;
}

/**
 * 重複取込を防ぐキー。口座・日付・入出金・金額・摘要・残高から作り、同じ内容の行が同じファイルに
 * 複数あるときは出現順の連番で区別する（同日に同額のコンビニ払いが2回、など）。
 * 期間が重なる CSV を取り込み直しても、同じ取引は同じキーになる。
 *
 * 連番はファイルごとに数え直すので、別のファイルにある別の取引（同日・同額・同摘要・同残高）が同じキーになりうる。
 * キーが同じことは同一取引の証明ではない。取込済みと同じキーの行を読み飛ばすかどうかは DB 側
 * （import_bank_statement）が決める。取込全体が同じ内容の再実行だと DB が確かめられた残高のある行だけを読み飛ばし、
 * それ以外はすべて捨てずに「重複の疑い」として人の確認に回す。
 */
export function buildDedupeKeys(walletId: string, rows: readonly ParsedStatementRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = [
      walletId,
      row.txnDate,
      row.direction,
      row.amount,
      row.description.normalize("NFKC"),
      row.balance ?? "",
    ].join("\u001f");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return createHash("sha256").update(`${base}\u001f${n}`).digest("hex");
  });
}
