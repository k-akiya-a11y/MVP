# 重複の判断(resolve_suspected_duplicate)の成功結果が検証されない: 実装前の期待記録

作成: 2026-11-05（コードを直す前の期待の記録。実装後にこの節を書き直さない。期待が誤っていた場合は末尾に日時と理由を追記する）。第 1 段階はテストとこの文書のみで、製品コードは変更していない。

## 目的

`submitDuplicateResolution`（`src/lib/review/submit.ts:133-148`）は、RPC `resolve_suspected_duplicate` の戻り値 `data` を受け取らず捨て、`error` が無ければ `{ ok: true }` を返す（`submit.ts:139,144`）。この RPC の戻り値は `uuid`（`supabase/migrations/20261020000800_duplicate_reviews.sql`）なので、`null`・空文字・UUID でない値は正常な応答ではあり得ない。`submitReview`（`submit.ts:117-118`）は同じ状況で UUID を検証して固定文の例外にしているが、こちらは検証がない。

業務上の問題: 壊れた応答でも「判断を記録した」と扱われ、画面（`duplicates-panel.tsx`）は成功として送信ガードを解除する。判断はコミット済みかもしれず、結果が不明のまま反対の判断や他の行の判断が送れてしまう。

## 入力と期待する出力（架空データ）

`bankTransactionId` は `00000000-0000-4000-8000-0000000000bb`、`resolution` は `distinct` と `duplicate` の両方。成功時の UUID は `00000000-0000-4000-8000-0000000000ee`（架空）。RPC のみモックする。

| RPC の応答 | 現在（コード読取による予測） | 期待 |
| --- | --- | --- |
| `{ data: "<正しい UUID>", error: null }` | `{ ok: true }` | `{ ok: true }`（変えない。UUID は返さない） |
| `data` が `null`、`undefined`、`""`、`"   "`、`"　"`、`"dup-1"`、UUID の前後に空白、UUID に文字を足したもの、`123`、`true`、`false`、`[]`、`["<UUID>"]`、`{}`、`{ id: "<UUID>" }`、目印入りの値（`error: null`） | `{ ok: true }` | 既存の固定文の `Error`（`確認の記録結果を取得できませんでした。記録済みの可能性があります`、`submit.ts:73`）で reject |
| 既知の拒否（`DUPLICATE_REFUSALS` の文面と SQLSTATE が一致）、`data` は何でも | `{ ok: false, error: <文面> }` | 同じ（`error` があるときは `data` を見ない） |
| 未知のエラー、`data` は何でも | 固定文の reject | 同じ |

## 例外・失敗時の扱い

- 不正な成功結果は、既存の `unknownResultError()` と同じ固定文の `Error` を投げる。元の値・検査の詳細（ZodError など）は載せず、`cause` も付けない。`ok:false` にはしない（記録済みかもしれないため）。
- RPC は 1 回だけ。再試行しない。
- サーバーアクション `resolveDuplicateAction` は reject を上に伝え、`revalidatePath` は呼ばない（現状の構造のまま）。画面の既存の `catch` が結果不明として扱い、再マウントまでロックする（変更しない）。

## 変えない範囲

- 入力検証、RPC 名・引数、`DUPLICATE_REFUSALS`、`submitReview`、`actions.ts`、`duplicates-panel.tsx`、SQL・マイグレーション、権限（RLS・承認者のみ除外）、依存関係。
- 戻り値の型 `{ ok: true } | { ok: false; error }`（UUID は返さない）。
- Human Approval・判断ログ・メール非送信の仕組み。既存の未コミット変更は保持する（追加のみ）。

## 追加・調整するテスト（第 1 段階、製品コードは未変更）

- `tests/unit/review-error-boundary.test.ts`: 新しい節「submitDuplicateResolution: error なしでも成功結果が uuid でなければ…」。`distinct`／`duplicate` の両方で、不正値 17 種の固定文 reject・RPC 1 回・引数・非漏洩、正しい UUID の `{ ok: true }`、既知の拒否は `data` が不正でも `ok:false`、未知のエラーは固定文、サーバーアクション経由の reject と `revalidatePath` 未実行。
- 同ファイルの旧成功モック `data: "dup-1"` を有効な UUID に直した（成功の契約が UUID を要求するため。期待の弱体化ではない）。
- `tests/unit/duplicates-panel-submission.test.ts`: 既存の hook 合成ハーネスに、`resolveDuplicateAction` のモックを実際の `submitDuplicateResolution`（偽 `rpc` つき）につなぐ節を追加。不正な応答で案内が出て、反対の判断・他の行・古いハンドラが送られない（RPC 1 回）。正しい UUID ではロックされず続けて送れる。再マウント後に再開できる。実 DB・Next は使わない。

## 予測（Codex が修正前に実行して確かめる。Claude は実行していない）

修正前に**失敗**すると予測:
- `review-error-boundary.test.ts` の不正値 17 種 × 2 resolution = 34 件（すべて `{ ok: true }` が返り reject されない）。
- 同ファイルのサーバーアクション経由 1 件（reject せず、`revalidatePath` も呼ばれる）。
- `duplicates-panel-submission.test.ts` の合成節のうち、不正な応答のテスト: 反対判断 2 件、不正値 8 件、再マウントの再開 1 件（最初の応答が成功扱いとなり案内が出ない）。

修正前に**通る**と予測: 正しい UUID の `{ ok: true }`（2 件）、既知の拒否（2 件）、未知のエラー（2 件）、パネルの正しい UUID の 1 件、UUID に直した旧成功テスト。

テストを緑にするために期待を弱めない。想定と違う結果は Codex がそのまま報告する。

## この記録が主張しないこと

- テストの実行結果（Claude は実行していない）。
- 実 DB の RPC が壊れた値を返した証拠。これは契約の防御であり、本番での発生を主張しない。

## 追記: テスト fixture の訂正（2026-11-05、実行前の独立レビューによる）

- 欠陥: `duplicates-panel-submission.test.ts` の合成節は実際の `submitDuplicateResolution` をつなぐが、既存の `ITEMS` の id（`D1`/`D2`）は UUID ではない。`duplicateResolutionSchema`（`bankTransactionId: z.string().uuid()`）の入力検証が先に `{ ok: false }` を返し、RPC に届かない。意図した「不正な成功結果 → 結果不明」の挙動を確かめられず、期待する RPC 引数の検査も成り立たない。
- 訂正: 合成節（この describe）だけに、架空の有効な UUID（`…0a1`、`…0a2`）の明細 `RPC_ITEMS` と、節内の `beforeEach`（hook 状態の初期化・`cur` の差し替え・初回描画）を置いた。期待する RPC の `p_bank_transaction_id` は `D1`/`D2` から同 UUID に直した。既存のテスト（`D1`/`D2` と `resolveDuplicateAction` のモック）と共有の fixture は変更していない。
- 非同期の settle: `settle()`（`setTimeout(0)`）で足りる。クリック → `resolve` → モック → `submitDuplicateResolution` → `callRpc` → 偽 `rpc` はタイマーを含まない Promise の連鎖（マイクロタスク）だけで、macrotask の `setTimeout(0)` より前にすべて完了する。入れ子の `async` が増えても同様。
- 期待は変えていない: 上の「予測」の件数・対象・通る／失敗する区分はそのまま。訂正前は入力検証で止まるため予測の根拠が成り立たなかった、という fixture 側の誤りの訂正であり、期待の弱体化ではない。テストは未実行。

## 追記: 修正前の赤テスト実績（Codex 実行の報告、2026-11-05）

Codex が報告した実行結果（Claude は実行していない。報告をそのまま転記）:

- コマンド: `node vitest run --project unit --pool threads tests/unit/review-error-boundary.test.ts tests/unit/duplicates-panel-submission.test.ts`
- 結果: 46 failed / 143 passed / 189 total、1.31s、exit 1。
- 内訳: `review-error-boundary.test.ts` が 35 件失敗、`duplicates-panel-submission.test.ts` が 11 件失敗。いずれも想定どおりで、reject されるべきところが `{ ok: true }` で resolve された（`ok: true` のまま）。パネル側は案内（結果不明）が出なかった（unknown absent）。
- 補足: 予測（34 + 1 件、パネル 11 件）と境界側の件数は上の予測の内訳に沿うが、この節は Codex の数値を記録するだけで、予測との照合は Codex の再実行結果で行う。
- 併せて判明したテストの欠陥: パネル合成節の `it.each([..., [], {}])` で、Vitest が `[]` を「引数なし」と解釈し `data` が `undefined` になっていた（`[]` が実際には試されず `undefined` と重複）。

## 追記: 実装の説明（2026-11-05）

### 製品コード（最小の修正）

- `src/lib/review/submit.ts` の `submitDuplicateResolution`（`submit.ts:133` 付近）だけを変更。
  - RPC の戻り値を `{ data, error }` で受け取る（従来は `error` のみ）。
  - `error` があるときは従来どおり `knownRefusal(DUPLICATE_REFUSALS, error, false)` で判定し、既知の拒否は `{ ok: false, error: 文面 }`、未知は `unknownResultError()`（エラー優先。`data` は見ない）。
  - `error` が無いときは `z.string().uuid().safeParse(data)` を検証し、失敗なら既存の `unknownResultError()`（固定文、`submit.ts:73-74`）を投げる。成功なら従来どおり `{ ok: true }`（UUID は返さない）。`submitReview`（`submit.ts:117-118`）と同じ方式。
- 変えていないもの: 関数のシグネチャ・引数・RPC 名と引数、入力検証、`DUPLICATE_REFUSALS`、`submitReview`、`actions.ts`、`duplicates-panel.tsx`、SQL・マイグレーション、権限、依存関係。

### テストの修正（期待は変えていない）

- `tests/unit/duplicates-panel-submission.test.ts` の合成節 `it.each([null, undefined, "", "   ", 123, true, [], {}])` を、各値を `{ data }` に包んだ記述子の配列にした。実際の空配列 `[]` が `data` として渡る。期待（固定文によるロック、RPC 1 回）は変更していない。

### 範囲

- 変更ファイルは `src/lib/review/submit.ts`、上記テスト 1 箇所、この文書のみ。

### 未検証

- 修正後のテストは Claude は実行していない。緑であるとは主張しない。Codex の再実行結果で確認する。

## 追記: Codex による最終検証（2026-11-05）

Codex が報告した修正後の実績を転記する（この節の実行は Codex。Claude は実行していない）。上の節は書き換えず、追記のみ。

### 実行結果（修正後）

| 確認 | コマンド | 結果 |
| --- | --- | --- |
| unit テスト全体 | `node node_modules/vitest/vitest.mjs run --project unit --pool threads` | 64 files / 1455 tests すべて PASS、45.83s、exit 0 |
| 型検査 | `node node_modules/typescript/bin/tsc --noEmit --incremental false` | exit 0 |
| lint | `node node_modules/eslint/bin/eslint.js .` | exit 0 |
| 差分の体裁 | `git diff --check` | exit 0（LF/CRLF の警告のみ） |

### 修正前の赤コマンドの訂正（追記のみ）

「修正前の赤テスト実績」の節のコマンド表記は省略形だった。実際に実行されたコマンドは `node node_modules/vitest/vitest.mjs run --project unit --pool threads tests/unit/review-error-boundary.test.ts tests/unit/duplicates-panel-submission.test.ts`。結果の数値（46 failed / 143 passed / 189 total、exit 1）は変更しない。

### Codex が確認した製品挙動

`src/lib/review/submit.ts` の `submitDuplicateResolution` について、Codex は次を確認した。
- データの検証は、`error` が無い応答でのみ行う。
- 正しい UUID は `{ ok: true }`（UUID は返さない）。
- 既知の拒否は従来どおり保持される（`ok: false` と文面）。
- 未知のエラー、および不正な成功結果は固定文のみで、内部情報（元の値・検査の詳細）を含まない。

### テストの性質と fixture

- 合成テスト（`tests/unit/duplicates-panel-submission.test.ts`）は、実際の `submitDuplicateResolution` とパネルのハンドラを、偽 RPC と hook ハーネスでつないだもの。実 DB・実ブラウザではない。
- テスト fixture の誤り（上記の「テスト fixture の訂正」と、`[]` が `undefined` と重複していた欠陥）は、最終の全体実行の前に訂正済み。

### 変更ファイル（この task 全体、4 件）

`src/lib/review/submit.ts`、`tests/unit/review-error-boundary.test.ts`、`tests/unit/duplicates-panel-submission.test.ts`、この文書。なお上の「範囲」の節は実装段階のみの記述で、task 全体の件数ではない。DB・マイグレーション・UI の製品コードは変更していない。認可・RLS の変更もない。

### リポジトリ状態

- ブランチ `fix/csv-integrity-and-proposal-hold`、HEAD `0763fdf0ae75fc7ae71387c91bf4dd28a35250d7`。
- `git status` の項目数は 91（開始時は 90）。既存の未コミット変更は保持している。
- テストは Codex が実行した。所有する実装・テストのプロセスはすべて終了済み（この文書の編集は、次に収集される）。サービス・docker・ブラウザは起動していない。
- 実 DB、AI 呼び出し、課金、バックアップ、push、公開は行っていない。

### 未実行・主張しないこと

- 最後の未実行ゲート: 今回の変更に対する、localhost の合成 DB と実ブラウザの HTTP で「壊れた応答」を注入するエンドツーエンド確認は未実行。実際の本番 DB を使う意図ではない。
- 本番で壊れた応答が発生した証拠は主張しない（防御的な契約検証である）。
- 確認した範囲では、残っている対応すべき指摘はない。ただし、リリース全体の承認ではない。

### 引き継ぎ（運用担当者向け）

- 壊れた応答を受け取ると、後続の判断は止まります。
- すでにコミットされた判断は取り消されません。
- 人が再試行する前に、画面を再読み込みして、状態と履歴を確認してください。
- この変更はコードのみです。自動の再試行、権限の変更、DB のロールバックは行いません。

## 追記: Codex による合成ブラウザ結合の実証（2026-11-05）

Codex が報告した実行結果を転記する（実行は Codex。上の節は書き換えず、追記のみ）。上の「未実行・主張しないこと」にある「localhost の合成 DB と実ブラウザの HTTP で壊れた応答を注入するエンドツーエンド確認」に対応する実証である。

### 区別: 以前の unit 1455 件は今回再実行していない

- 「Codex による最終検証」の unit 全体 64 files / 1455 tests PASS は、前回の実行結果であり、今回の合成ブラウザ結合の作業では**再実行していない**。今回の結果と合算・混同しない。
- 今回、製品コードは変更していない。

### 環境

- ブランチ `fix/csv-integrity-and-proposal-hold`、HEAD `0763fdf`。
- 作業ツリーのコピー 116 ファイルが、リポジトリの SHA256 と一致した。
- 隔離したローカル Supabase にマイグレーション 17 件を適用済み。可視性は admin / staff / other = 2 / 1 / 1。
- fixture は SQL で直接投入した合成データ（元の取引 1 件 + 疑い 4 件）。**CSV 取り込みの試験ではない**。

### 注入手段

- 外部スクリプト `scripts/rpc-result-fault-proxy.mjs` のみ、Claude が変更した。追加は `bad-duplicate-next` モードだけ。
- 動作: `resolve_suspected_duplicate` への正確な POST について、上流が 200 で正しい UUID を返した後、応答の UUID を不正な文字列に 1 回だけ置き換える。上流の処理（DB へのコミット）自体は通常どおり行われる。
- Codex がレビューし、`node --check` は通った。

### 実ブラウザ（実際の admin）での結果

| 対象 | 注入 | 結果 |
| --- | --- | --- |
| `DUPE-PENDING`（`distinct`） | コミット後に不正な ID | サーバーアクション 500。固定の「結果不明」文が表示され、8 ボタンすべてが無効化。同じ行の反対判断・別の行へのネイティブクリックは、リクエストが送られなかった（カウンタ 19 のまま）。DB の監査は 1 件、状態は distinct で新規。再読み込みで疑い 3 件、操作は有効に戻った。 |
| `DUPE-UNKNOWN`（`duplicate`） | コミット後に不正な ID | 結果不明、6 ボタンすべて無効化。同じ行の反対判断・別の行へのネイティブクリックで、カウンタ 33 のまま。DB の監査は 2 件、行は new と duplicate。再読み込みで疑い 2 件。 |
| `DUPE-STALE`（`distinct`、通常の 3 件目） | 注入なし（正しい UUID） | サーバーアクション 200。疑い 1 件、操作は有効。監査 3 件（各 resolved 行 1 件）、executions は 0。 |

- 台帳（ブラウザ）は 5 行。状態は、original、PENDING / STALE が new、UNKNOWN が duplicate、OTHER が suspected。
- 「履歴」の証拠は `duplicate_reviews` の DB 件数と resolution であり、`human_reviews` の履歴 UI（別テーブル）の確認ではない。

### 操作上の注記

- 初回ログインで CDP がタイムアウトしたが、確認の結果ログインは完了していたため、ログインを繰り返していない。
- 終了時、ブラウザはログアウト（303）し、タブも閉じた。アプリと helper は意図的に Ctrl+C で終了（exit 1）、proxy は quit（exit 0）。
- Docker とファイルの後片付けは Codex が検証済み（Claude は実行していない）:
  - `docker compose down --volumes` は exit 0。専用の 4 コンテナ・2 ボリューム・1 ネットワークを削除した。絞り込んだ `docker ps -a`／volume／network の一覧はいずれも該当なし。
  - 待ち受けポート 3100、3101、55321、55322、55323 は、いずれも 0 件。
  - `cleanup-files --yes` は exit 0。app、`.local`、seed-source、標準 CSV、コピーしたマイグレーション 17 件を削除した。
  - `git diff --check` は exit 0（CRLF の警告のみ）。`git status` の項目数は 91 のまま変わらない。

### 限界（行っていないこと）

- 実 AI 呼び出し、実 DB（本番）、OAuth、CSV アップロード、新たな cross-tab・権限の試験は行っていない。
- 注入は応答の置き換えであり、本番で壊れた応答が発生した証拠ではない。
- 上記は合成データ・ローカル環境・単一の admin による確認に限る。
- リリース全体および本番利用の承認ではない。
