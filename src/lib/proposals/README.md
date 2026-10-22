# src/lib/proposals

明細1件の仕訳候補づくり（設計書1章の処理2〜4）。`propose.ts` がルール照合（`rules/`）→ 過去仕訳検索（`retrieval/`）→ ルールに一致しなければ AI（`ai/`）→ 確信度（`confidence/`）の順に組み立て、判断ログ1行分の中身を返します。`run.ts` は未判定の明細をまとめて処理し、`store.ts` の `record_ai_decision` で判断ログに記録します。外部への書込はしません。
