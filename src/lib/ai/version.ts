/**
 * AI のモデルとプロンプトの版（CLAUDE.md 8章: 定数で固定する）。
 * 変えるときは修正済み事例（正解付きテストセット）で正答率が悪化しないことを確認してから切り替える。
 * 判断ログには、この2つを必ず記録する。
 */
export const JOURNAL_MODEL = "claude-sonnet-5-5";
export const JOURNAL_PROMPT_VERSION = "journal-proposal/2026-10-20.1";

/** Claude Sonnet 5.5 の料金（100万トークンあたり、100万分の1ドル単位の整数）。2026-10 時点 */
export const JOURNAL_MODEL_PRICE_MICROS_PER_MTOK = {
  input: 2_000_000,
  output: 10_000_000,
  cacheRead: 200_000,
  cacheWrite: 2_500_000,
} as const;
