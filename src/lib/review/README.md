# src/lib/review

承認画面のデータ読込（`queue.ts`、ログインした担当者の権限で RLS あり）と、人の確認の記録（`submit.ts`）。確認は DB 関数 `record_human_review` だけを通し、確認者は DB 側で `auth.uid()` に固定されます。承認・修正の結果はその場で過去仕訳に加わります。freee への書込はしません（承認済みの実行は `src/lib/execution/` が行う）。
