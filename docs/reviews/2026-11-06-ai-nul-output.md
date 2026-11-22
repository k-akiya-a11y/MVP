# AI の回答の文字列に NUL（U+0000）があると、検証を通って判断ログの記録で失敗する: 実装前の期待記録

作成: 2026-11-06（コード・テストを書く前の期待の記録。実装後にこの節を書き直さない。期待が誤っていた場合は末尾に日時と理由を追記する）。この記録の時点では、製品コードは変更しない。

## 目的

`claudeJournalAi` は、回答の JSON が `aiJournalOutputSchema` に合えば `status: "ok"` で返す。スキーマの `description` / `reason` / `unknowns` は `z.string()` で、NUL（U+0000）を拒否しない。JSON の `"\u0000"` は `JSON.parse` で本物の NUL 1文字になるため、JSON としては正しい回答に NUL が入りうる。

`proposeForTransaction` はこの文字列を `ai_output`・`ai_reason`・`ai_unknowns`・`proposal.description` に入れ、`toAiDecisionRow` がそのまま判断ログの行にする。PostgreSQL の text / jsonb は NUL を保存できないため、`recordDecision` が失敗する。その明細は「未判定」のまま残り、巡回が戻るたびに AI が再び呼ばれ、同じ NUL が返れば失敗と費用が繰り返される。さらに、失敗した呼出しの使用量・費用は判断ログに残らない。

NUL を含む回答は、記録の前に（`claudeJournalAi` の中で）`invalid` にし、担当者に回すべきである。

元コードの根拠（読取のみ。Claude は実行していない）:

- `src/lib/ai/schema.ts:15-17`: `description` / `reason` / `unknowns` は NUL を検査しない文字列。
- `src/lib/ai/client.ts:69-80`: `JSON.parse` → `safeParse` が成功すれば `status: "ok"` で `parsed.data` を返す。
- `src/lib/proposals/propose.ts:92-99, 101-102`: `ok` の回答の `reason` / `unknowns` / `output` をそのまま `aiLog` に入れ、`validated.entry.description` を `proposal` にする。`cannot_decide` でも `reason` / `unknowns` / `output` は入る。
- `src/lib/audit/decision-log.ts:21-43`: 上記をそのまま行（`proposal` / `ai_output` / `ai_reason` / `ai_unknowns`）にする。
- `src/lib/proposals/run.ts:137-145`: 記録の失敗は `failures` に入り、貸出しは返されて次の巡回で再び判定される。
- PostgreSQL が NUL を保存できないことは、`docs/reviews/2026-11-05-csv-nul-description.md` で一次情報（公式文書 8.3）を確認済み。この記録では実 DB での実行確認はしない。

## 期待する動作（修正後）

1. `claudeJournalAi` は、JSON の解析とスキーマ検証に成功した**後**、`ok` を返す前に、`output.description`・`output.reason`・`output.unknowns` の各要素のいずれかに U+0000 が1文字でも含まれるかを調べる。含まれていれば `status: "invalid"` を返す。位置は問わない（先頭・途中・末尾・NUL だけ）。
2. 対象は `decision` が `proposal` でも `cannot_decide` でも同じ。
3. `invalid` の `model`・`promptVersion`・`usage`（費用を含む）は、ほかの `invalid` と同じく残す。`output` は含めない。`messages.create` は1回だけ呼ぶ（再試行しない）。
4. `detail` は**固定の安全な日本語の文言**で、`NUL` を含む。NUL 文字そのものも、回答の本文（摘要・理由・不明点の内容）も、スキーマ検証の生のエラー文も含まない。どの項目・どの位置の NUL でも同じ文言にする（項目名で変えない）。複数の項目に NUL があっても1件の `invalid`。
5. `proposeForTransaction` は変更しない。既存の `invalid` の経路により、`proposal` は null、確信度は「低」、`ai_output` と `ai_reason` は null、`ai_unknowns` は `AI の回答を使えません（invalid: <固定のdetail>）` の1件になる。`model`・`prompt_version`・トークン数・`cost_usd_micros` は行に残る。
6. `toAiDecisionRow` が返す行（`transaction_snapshot`・`confidence_breakdown` を含む全体）のどこにも本物の NUL がない。
7. 値は書き換えない。NUL を取り除く・置換する・切り捨てることはしない。回答全体を `invalid` にするだけ。
8. NUL のない回答は変えない:
   - 日本語・改行（`\n`）を含む `description` / `reason` / `unknowns` は `ok` で、一文字も変わらず `proposal`・`ai_output`・`ai_reason`・`ai_unknowns` に入る。
   - 文字としての `\u0000`（バックスラッシュ + `u0000` の6文字。JSON 上は `\\u0000`）は NUL ではないので `ok`。
   - NUL のない `cannot_decide` は従来どおり `ok`。

## エラー

| 回答（JSON としては正しい） | 結果 |
| --- | --- |
| `description` の先頭・途中・末尾に NUL、または NUL だけ | `invalid`・固定の detail。`ok` にしない |
| `reason` の同様の位置 | 同上 |
| `unknowns` のいずれかの要素の同様の位置 | 同上 |
| `cannot_decide` で上記のいずれか | 同上 |
| 複数項目に NUL | 1件の `invalid` |
| JSON として読めない／スキーマに合わない | 従来どおり（`JSON として読めません`／スキーマの検証エラー）。この記録では変更しない |

## 架空の具体例

`␀` は U+0000 を表す（実際のテストでは `"\u0000"`）。

- 入力: `description` が `漏れてはいけない架空の摘要XYZ␀`、ほかは正常（科目 105・税区分 21・取引先 302）。使用量は入力1000・出力200・キャッシュ読取3000。
- 予測する出力: `status: "invalid"`、`detail` は固定文言（`NUL` を含み、「漏れてはいけない…」を含まない）、`usage.costUsdMicros` 4600、`model` はレスポンスのモデル名、`promptVersion` は `JOURNAL_PROMPT_VERSION`。
- 判断ログの行: `proposal` null、`confidence` `low`、`ai_output` null、`ai_reason` null、`ai_unknowns` は1件、`cost_usd_micros` 4600。行のどこにも本物の NUL と元の摘要がない。

変わらない例:

| 回答 | 期待 |
| --- | --- |
| `description` `11月分\n家賃（本社）`、`reason` と `unknowns` も日本語・改行入り | `ok`。`proposal`・`ai_output`・`ai_reason`・`ai_unknowns` に同一の文字列 |
| `description` `摘要\u0000`（文字としての6文字） | `ok`。6文字のまま行に入る |
| NUL のない `cannot_decide` | `ok`。理由と不明点がそのまま残る |

## 変更しない範囲

- **`description` / `reason` / `unknowns` の NUL だけを対象にする。** 他の制御文字の方針は決めない・テストしない。改行・タブは従来どおり許可する。
- **プロンプトの版（`JOURNAL_PROMPT_VERSION`）、モデル（`JOURNAL_MODEL`）、構造化出力のスキーマ（`aiJournalOutputSchema` と `zodOutputFormat` に渡す JSON スキーマ）は変更しない。** 変更すると正解付きテストセットでの評価が必要で、有料の評価は保留中のため。実行時の検査を `claudeJournalAi` に足すだけにする。
- `proposeForTransaction`・`toAiDecisionRow`・`run.ts`・ストア・DB・マイグレーション・UI・依存関係。
- NUL の除去・置換・切り捨て。
- 実 API・実 DB・SDK のネットワーク呼出し（テストは `messages.create` のモック）。
- すでに記録された判断ログの調査・修復（NUL を含む行は DB に入らないので、存在しない想定。確認は別作業で Ken の判断が必要）。
- `docs/reviews/2026-11-06-proposal-budget-after-claim.md`（別作業。この作業では触れない）。

## 実装方針（最小・今回は実装しない）

`src/lib/ai/client.ts` で `safeParse` が成功した直後、`status: "ok"` を返す前に、`parsed.data.description`・`parsed.data.reason`・`parsed.data.unknowns` のいずれかに `"\u0000"` が含まれるかを調べ、含まれていれば `{ status: "invalid", ...common, detail: <固定文言> }` を返す。固定文言は定数にし、NUL 文字そのものをソースに書かない（エスケープで書く）。ほかのファイルは変更しない。

## テスト（今回追加する。製品コードは未変更）

`tests/unit/ai-nul-output.test.ts`。架空データのみ。`Anthropic.messages.create` は `vi.fn` のモック（既存の `tests/unit/ai-client.test.ts` と同じ方式）で、本物の `claudeJournalAi` → `proposeForTransaction` → `toAiDecisionRow` を通す。

- 3項目 × 先頭・途中・末尾・NUL だけ、および `cannot_decide` の3項目で、`invalid`・固定 detail・使用量／モデル／版の保持・`create` 1回。
- detail が NUL・回答の本文を含まないこと、全ケースで同一であること。
- 判断ログの行: `proposal` null・確信度 `low`・`ai_output`/`ai_reason` null・`ai_unknowns` 1件・行全体（キーを含む）に NUL なし・元の本文なし・トークン数／費用／モデル／版が残ること。
- 変わらないもの: 日本語＋改行、文字としての `\u0000`、NUL のない `cannot_decide` が `ok` で同一に残ること。

## この記録が主張しないこと

- テストの実行結果。Claude は実行していない（コマンドを一切実行していない）。修正前に失敗することは Codex が確認する。
- 実在のモデルが NUL を含む回答を返すこと。モックによる防御的な検査である。
- PostgreSQL が NUL を拒否することの実 DB での確認。
- 型検査・lint の結果。
- すでに記録されたデータの確認・修復、他の制御文字の方針。

## 追記 2026-11-06: 修正前の赤（Codex の実行結果）と実装

修正前の対象テスト（Codex が実行。Claude は実行していない。以下は依頼者経由で受け取った報告）:

- 対象テスト 53 件: 50 件失敗・3 件成功、終了コード 1、所要 616ms。
- 失敗の内容: 期待は `invalid`、実際は `ok`。NUL を含む安全でない出力が判断ログの行まで届いた。
- 成功の 3 件は「変わらない例」（日本語＋改行、文字としての `\u0000`、NUL のない `cannot_decide`）に対応する。

実装（`src/lib/ai/client.ts` のみ）:

- `safeParse` 成功後、`ok` を返す前に `description`・`reason`・`unknowns` の各要素に U+0000 が含まれるかを調べ、含まれれば `{ status: "invalid", ...common, detail: <固定文言> }` を返す。
- 固定文言は `回答の文字列に NUL 文字が含まれています`。NUL 自体・回答の本文・不正な値は載せない。NUL はソースにエスケープ（`"\u0000"`）で書く。
- `model`・`promptVersion`・`usage` は `common` のまま。API リクエストのスキーマ・プロンプト・モデルは変更していない。テストは変更していない。

未確認: 修正後のテスト結果（全テストは Codex が実行する）、型検査・lint、実 DB・実 API。

## 追記 2026-11-06: 最終結果（Codex の実行結果）と時系列の訂正

以下は Codex が実行した結果を依頼者経由で受け取った報告。Claude は実行していない。

### 最終結果

- `node node_modules/vitest/vitest.mjs run --project unit --pool threads --reporter=dot`: 70 ファイル、1685 件成功、0 件失敗、終了コード 0、49.30 秒。
- 追加した 53 件はすべて成功。修正前は 50 件失敗・3 件成功だった（上の追記のとおり）。
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`: 終了コード 0。
- `node node_modules/eslint/bin/eslint.js .`: 終了コード 0。
- `git diff --check`: 問題 0 件。

### Codex によるレビュー

- 対象は追加された `client.ts` の 8 行のみ。
- 解析後の文字列 3 項目（`description`・`reason`・`unknowns`）を検査し、固定の安全な `invalid` の detail を返すことを確認した。
- 共通の `usage` と `model` が保持されることを確認した。
- 下流で、確信度「低」、`proposal` なし、`ai_output` に NUL なし、という監査ペイロードになることをモックで確認した。
- プロンプト・モデル・スキーマは変更していない。

### 時系列の訂正

冒頭の記録は「コード・テストを書く前」と書いているが、実際に観察された順序は次のとおりで、**テストファイルはこの記録より先に保存されていた**。この記録がテストより前に作られたとは主張しない。

- 期待する動作は、依頼文の中に、この記録とテストの両方より前から存在した。
- この記録が保存されたのは、製品コードの修正と、修正前の赤（失敗）の実行より前だった。
- 上の「期待する動作」「エラー」「変更しない範囲」は書き直していない。

### 利用者向けの挙動

- AI の回答に NUL が含まれる場合は `invalid` となり、判断ログには確信度「低」で記録され、人の確認に回る。理由（安全な固定文言）と使用量は残る。
- 回答の生の本文（不正な値）は保存されない。
- 人の承認の扱いは変えていない。

### 範囲と未確認

- 過去のデータの修復はしていない。
- ロールバックする場合は、今回追加した検査の削除だけを確認すればよい。
- SDK のネットワーク呼出し、DB、ブラウザのテストは実行していない。実 DB への保存、プロバイダーの回答品質は主張しない。

### 状態

- 以前の保留中の文書（`docs/reviews/2026-11-06-proposal-budget-after-claim.md`）の SHA-256 は `3142146EC1895AF7400257E3013815B9A3AD06D253A3A044A2A291DFCED3CB26` のまま変わっていない。復元はしない。
- ブランチ `fix/csv-integrity-and-proposal-hold`、HEAD `0763fdf0ae75fc7ae71387c91bf4dd28a35250d7`。status の 109 件は保持されている。
- 環境は起動しておらず、所有していたプロセスはすべて終了している。

## 追記 2026-11-06: DB 結合テストの検証（Codex の実行結果）

以下は Codex が実行した結果を依頼者経由で受け取った報告。Claude は実行していない。この追記は追記のみで、上の既存の記載は書き直していない。

### 対象

- Codex が新しい `tests/db/ai-nul-output.test.ts` をレビューし、実行した。
- 本物にしたもの: ローカルの対象ガード、使い捨て DB、shim と 17 本のマイグレーション、seed、`service_role` での SQL、ロールバック、使い捨て DB の削除。
- 代役にしたもの: Anthropic SDK の `messages.create` とコンテキスト（偽物）のみ。実 API・実 DB・外部費用は使っていない。
- 本物の `claudeJournalAi` のパーサー、`proposeForTransaction`、`toAiDecisionRow`、claim 用 SQL と record 用 SQL を通した。pg の接続から SQL を直接呼ぶため、PostgREST・`runProposalJob`・ブラウザは経由していない。

### 実行

- コマンド: `node node_modules/vitest/vitest.mjs run --project db --pool threads tests/db/ai-nul-output.test.ts --reporter=verbose`
- 結果: 9 件成功、0 件失敗、終了コード 0、738ms。
- DB: PostgreSQL 17.11（公式イメージ、digest `839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5`）。`127.0.0.1:55439` に bind、データは tmpfs。

### 確認された内容

- NUL の 6 ケース（`description` / `reason` / `unknowns` の 3 項目 × `proposal` / `cannot_decide`）で、実際に保存された行は次のとおり。
  - 確信度 `low`、`proposal` null、`ai_output` null、`ai_reason` null、`ai_unknowns` は安全な固定文言。
  - `model`・`prompt_version`・全使用量（合成の費用 4600 を含む）が残った。
  - 判断は ちょうど 1 件。明細は `proposed`、貸出し 0 件。レビューと実行ログは増えていない。
- 有効な 3 ケース（日本語＋改行、文字としての `\u0000`、通常の `cannot_decide`）は変わらず保存された。
- 各テストは単一トランザクションでロールバックする。耐久性・クラッシュのテストではない。

### その他の検証

- `node node_modules/typescript/bin/tsc --noEmit --incremental false`: 終了コード 0。
- `node node_modules/eslint/bin/eslint.js .`: 終了コード 0。
- 先の 1685 件の単体テストは、今回は再実行していない。

### 後始末

- 一時 DB の数は 0 を確認。コンテナは停止し、自動削除された。

### 範囲

- 製品コードは変更していない。変更したのはこの追記と、`tests/db/ai-nul-output.test.ts` の先頭コメント（古い「未実行」の記載をこの追記への参照に更新）のみで、実行されるコードは編集していない。
- 保留中の `docs/reviews/2026-11-06-proposal-budget-after-claim.md` には触れていない。
- 既存部分が元のバイト列と完全に一致すること（接頭辞の一致）は、Codex が確認するまで確認済みと主張しない。Claude はコマンドを実行していない。
