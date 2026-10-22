/**
 * 明細の金額・日付の解釈。金額は整数（円）だけを受け付け、小数は誤りとして扱う。
 */

/** "1,234" "￥1,234" "¥ 1,234円" "-500" "△500" "(500)" を整数の円にする。空欄は null。 */
export function parseYen(raw: string): number | null {
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
  s = s.replace(/[¥\\円,\s]/g, "");
  if (!/^\d+$/.test(s)) {
    throw new Error(`金額を整数の円として読めません: "${raw}"`);
  }
  const value = Number(s);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`金額が大きすぎます: "${raw}"`);
  }
  return negative ? -value : value;
}

/** "2026/10/01" "2026-10-01" "2026.10.1" "20261001" "2026年10月1日" を YYYY-MM-DD にする */
export function parseStatementDate(raw: string): string {
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
