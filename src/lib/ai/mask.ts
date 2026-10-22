/**
 * AI に送る前に伏せる（CLAUDE.md 7章）。口座番号・カード番号・電話番号などの長い数字を * にする。
 * 日付や金額は別の項目で渡すので、摘要の中の長い数字は判定に要らない。
 */
export function maskSensitive(text: string): string {
  const d = "[0-9０-９]";
  return (
    text
      // カード番号（4桁ずつ空白区切り）
      .replace(new RegExp(`${d}{4}(?:[ 　]${d}{4}){2,3}`, "g"), (m) => "*".repeat(m.length))
      // ハイフン区切りを含む7桁以上の数字
      .replace(new RegExp(`${d}(?:${d}|[-－]){5,}${d}`, "g"), (m) =>
        m.replace(/[-－]/g, "").length >= 7 ? "*".repeat(m.length) : m,
      )
  );
}
