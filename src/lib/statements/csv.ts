/**
 * RFC 4180 形式の CSV を行・列に分ける。ダブルクオート内のカンマ・改行・"" に対応する。
 * 銀行・カード会社の CSV は CRLF が多いので CR も改行として扱う。
 *
 * 形式が壊れている CSV は黙って直さず CsvSyntaxError を投げる（閉じられていないクオートが後続の取引を
 * 摘要に飲み込む、クオートの後ろに余分な文字がある、など。読めた気になった一部の行だけが取り込まれるのを防ぐ）。
 */
export function parseCsv(text: string): string[][] {
  return parseCsvWithLines(text).map((r) => r.cells);
}

/** CSV の形式の誤り。line は問題を見つけたファイル上の行（1始まり） */
export class CsvSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = "CsvSyntaxError";
  }
}

/** CSV の1行と、ファイル上の行番号（1始まり。クオート内の改行で複数行にまたがるときは開始行） */
export type CsvRow = { cells: string[]; line: number };

/**
 * parseCsv と同じだが、空行を除いた後もファイル上の行番号を保つ（エラーの行番号を CSV と一致させるため）。
 * クオートの規則（RFC 4180）:
 *   - クオートで始められるのはフィールドの先頭だけ（途中の " は誤り）
 *   - 閉じクオートの直後は , 改行 ファイル末尾のどれか（それ以外の文字は誤り）
 *   - ファイル末尾までに閉じられないクオートは誤り（行番号は開いた行）
 */
export function parseCsvWithLines(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let physicalLine = 1;
  let rowStart = 1;
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoteOpenedAt = 1;
  // クオートで閉じた直後のフィールドか（次に来てよいのは , 改行 ファイル末尾だけ）
  let closedQuote = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        if (ch === "\n" || (ch === "\r" && src[i + 1] !== "\n")) physicalLine++;
        field += ch;
      }
      continue;
    }
    const isDelimiter = ch === "," || ch === "\r" || ch === "\n";
    if (closedQuote && !isDelimiter) {
      throw new CsvSyntaxError("閉じクオートの後ろに余分な文字があります", physicalLine);
    }
    if (ch === '"') {
      if (field !== "") {
        throw new CsvSyntaxError("値の途中にダブルクオートがあります（クオートは値の先頭だけに置けます）", physicalLine);
      }
      inQuotes = true;
      quoteOpenedAt = physicalLine;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      closedQuote = false;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push({ cells: row, line: rowStart });
      row = [];
      field = "";
      closedQuote = false;
      physicalLine++;
      rowStart = physicalLine;
    } else {
      field += ch;
    }
  }
  if (inQuotes) {
    throw new CsvSyntaxError(`ダブルクオートが閉じられていません（${quoteOpenedAt}行目で開いたクオート）`, quoteOpenedAt);
  }
  if (field !== "" || row.length > 0 || closedQuote) {
    row.push(field);
    rows.push({ cells: row, line: rowStart });
  }
  // 空行は捨てる
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ""));
}
