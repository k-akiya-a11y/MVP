/**
 * 明細の金額・日付の解釈。金額は整数（円）だけを受け付け、小数は誤りとして扱う。
 */

/** "1,234" "￥1,234" "¥ 1,234円" "-500" "△500" "(500)" を整数の円にする。空欄は null。書式が壊れた金額は誤り。 */
export function parseYen(raw: string): number | null {
  // NUL は文言に入れると診断の JSONB 保存が失敗する。元の値を含めず、除去もせずに拒否する
  if (raw.includes("\u0000")) throw new Error("金額に NUL（U+0000）が含まれているため読めません");
  let s = raw.normalize("NFKC").trim();
  if (s === "") return null;
  let negative = false;
  if (s.startsWith("△") || s.startsWith("▲") || s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  // 符号・括弧の内側の空白は許す。数字の途中の記号・空白・不正なカンマ位置は連結せず誤りにする。
  const m = /^(?:[¥\\]\s*)?(\d+|\d{1,3}(?:,\d{3})+)(?:\s*円)?$/.exec(s.trim());
  if (!m) {
    throw new Error(`金額を整数の円として読めません: "${raw}"`);
  }
  const value = Number((m[1] as string).replace(/,/g, ""));
  if (!Number.isSafeInteger(value)) {
    throw new Error(`金額が大きすぎます: "${raw}"`);
  }
  return negative ? -value : value;
}

/** "2026/10/01" "2026-10-01" "2026.10.1" "20261001" "2026年10月1日" を YYYY-MM-DD にする */
export function parseStatementDate(raw: string): string {
  if (raw.includes("\u0000")) throw new Error("日付に NUL（U+0000）が含まれているため読めません");
  const s = raw.normalize("NFKC").trim();
  let m = /^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?$/.exec(s);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) {
    throw new Error(`日付を読めません: "${raw}"`);
  }
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`存在しない日付です: "${raw}"`);
  }
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
