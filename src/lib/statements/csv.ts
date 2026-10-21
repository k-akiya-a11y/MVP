/**
 * RFC 4180 形式の CSV を行・列に分ける。ダブルクオート内のカンマ・改行・"" に対応する。
 * 銀行・カード会社の CSV は CRLF が多いので CR も改行として扱う。
 */
export function parseCsv(text: string): string[][] {
  return parseCsvWithLines(text).map((r) => r.cells);
}

/** CSV の1行と、ファイル上の行番号（1始まり。クオート内の改行で複数行にまたがるときは開始行） */
export type CsvRow = { cells: string[]; line: number };

/** parseCsv と同じだが、空行を除いた後もファイル上の行番号を保つ（エラーの行番号を CSV と一致させるため） */
export function parseCsvWithLines(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let physicalLine = 1;
  let rowStart = 1;
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n" || (ch === "\r" && src[i + 1] !== "\n")) physicalLine++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push({ cells: row, line: rowStart });
      row = [];
      field = "";
      physicalLine++;
      rowStart = physicalLine;
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push({ cells: row, line: rowStart });
  }
  // 空行は捨てる
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ""));
}
