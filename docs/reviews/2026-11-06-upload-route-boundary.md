# 明細CSVアップロード route の境界テスト: 計画と説明

作成: 2026-11-06。Claude がテストを書き、Codex がレビューする。対象は `src/app/api/customers/[customerId]/statements/route.ts`。製品コードは変更していない。**最終検証として unit 全体テスト・型検査・lint がすべて通過した**（下の「実行状況」を参照）。Codex が route とテストを独立にレビューし、明示的な undefined guard も確認した。

## 目的

従来、この route 自体を直接呼ぶテストは無かった（取込ロジックは `importStatementCsv`、DB は `tests/db/` で別に確認済み）。route が持つ次の責任を、外部（Supabase・AI）を使わず固定する。

- 認証と顧客IDの検査が、フォーム読取・口座検索・取込より前に働くこと。
- 口座の検索が URL の顧客ID と送られた口座IDの**両方**に紐付くこと。
- 失敗時に取込へ進まず、内部の詳細を返さないこと。
- 成功時に、認証済みのクライアントと正確な値だけを取込へ渡すこと。

## 実装前の計画（期待する出力）

| 入力 | 期待 | 取込 |
| --- | --- | --- |
| 顧客IDが UUID でない | 400「顧客IDが不正です」。クライアント作成・`formData()` も呼ばない | 呼ばない |
| 未ログイン（他は全て正しい） | 401。`formData()`・口座検索を呼ばない | 呼ばない |
| file/walletId/formatId の欠落・型違い・不正 UUID・空 | 400。口座検索しない | 呼ばない |
| 5MB+1 バイト（合成） | 413。口座検索しない | 呼ばない |
| ちょうど 5MB | 上限内（取込へ進む） | 呼ぶ |
| 口座が別顧客のもの／0 行 | 404 | 呼ばない |
| 口座検索がエラー | 500 の汎用文言のみ（内部メッセージ・コードを含まない） | 呼ばない |
| 未対応の kind | 404 | 呼ばない |
| bank_account / credit_card | 認証済みクライアントを gateway に渡し、顧客・口座・種類・名前・バイト列を一致で渡す | 1 回 |
| 取込が `ok:true` / `ok:false` | 200 / 422 で結果をそのまま返す | — |

## 実際の route の行との対応

- 22–25 行: `customerId` を UUID 検査。失敗は 400。`createUserClient` より前なので、不正IDではクライアントも作られない。
- 27–31 行: `createUserClient` → `auth.getUser()`。ユーザー無しは 401。`request.formData()`（33 行）より前。認証を外すとテスト「未ログイン」が 200 等になり失敗するはず（読解による想定で、変異実験は未実施）。
- 33–38 行: フォーム検査。欠落・不正は 400（`file instanceof File` を含むので文字列の file も弾く）。
- 39–41 行: `file.size > MAX_BYTES`（5MB）で 413。ちょうど 5MB は通る。
- 44–49 行: `wallets` を `select("kind")`、`.eq("id", walletId)`、`.eq("customer_id", customerId)`。テストは (1) 記録した絞り込みに両方があること、(2) 別顧客の行を持つ偽データで 404 になることの両面で確認する。`customer_id` の絞り込みを外すと (1)(2) とも失敗するはず（読解による想定で、変異実験は未実施）。
- 50–52 行: 検索エラーは固定文言の 500。DB のエラー内容は応答に入れない。
- 53–56 行: `kind` を zod で検査。行が無い（null）または未対応の kind は 404。
- 58–68 行: `importStatementCsv` に顧客・口座・種類・ファイル名・formatId・バイト列と `supabaseStatementImportGateway(supabase)` を渡す。`supabase` は 27 行で作った同じクライアントであることを、同一性（`toBe`）で確認する。
- 69 行: `ok` なら 200、そうでなければ 422 で結果をそのまま返す。

## 限界（明示）

- **これは route ハンドラの直接テストであり、HTTP・ブラウザ・RLS の証明ではない。** 本物の `Request` / `FormData` でハンドラを直接呼ぶが、認証・DB・取込は mock である。実際の HTTP 経由の挙動やブラウザからの送信は確認していない。
- **本物の RLS はこのテストでは証明しない。** 偽クライアントは絞り込み条件に合う行を返すだけで、RLS を再現しない。「RLS で隠れた行は 404」は「検索結果が空なら 404」という route の振る舞いの確認に限る。RLS は `tests/db/` の既存 DB テストが別に確かめる。
- route の `wallet` 種別（`walletSchema` に含まれる）の取込は本テストの対象外（依頼は bank/card のみ）。
- `formatId` の実在検査は取込側（`importStatementCsv`）の責任で、ここでは扱わない。
- `request.formData()` が例外を投げる場合（不正な multipart）は route に処理が無い。テストは書いていない。**未テストの候補であり、製品の欠陥として証明されたものではない。** 変更はしていない。
- ソースを変異させる実験（認証や `customer_id` 絞り込みを外して失敗を確かめる等）は実行していない。上の「〜を外すと失敗する」は、コードの読解に基づく説明であり、実測ではない。

## 実行状況（時系列）

上の「実装前の計画（期待する出力）」は当初の計画のまま残している。以下が実際の経過と最終結果である。

1. 初回: 対象テスト（`tests/unit/statement-upload-route.test.ts`）は 22 件通過。このとき型検査は 4 件の strict エラー（「undefined の可能性」: 口座検索の記録の取り出し 2 件、`mock.calls[0]` の参照と分割代入 2 件）で失敗しており、全体テストと lint は未実行だった。
2. 修正: 上記 4 件を、テスト内の明示的な undefined guard で修正した。製品コードの変更は無い。
3. Codex レビュー: route とテスト（明示的な undefined guard を含む）を独立にレビューした。
4. 最終検証（完了済み）:
   - `node node_modules/vitest/vitest.mjs run --project unit --pool threads`: 73 ファイル・1768 テストが全て通過（45.22 秒）。今回の 22 件の新規テストを含む。
   - `node node_modules/typescript/bin/tsc --noEmit --incremental false` に続けて `node node_modules/eslint/bin/eslint.js .` を連結して実行し、exit 0。先の 4 件の型エラーは解消済みで、残っていない。
   - `git diff --check`: exit 0（既存の LF/CRLF の通知あり）。

ブランチ `fix/csv-integrity-and-proposal-hold`、HEAD `0763fdf0ae75fc7ae71387c91bf4dd28a35250d7`。今回のターンの追加は 2 件のみで、製品コードの変更は無い。一時停止中の提案予算の文書のハッシュは変更なし（`3142146EC1895AF7400257E3013815B9A3AD06D253A3A044A2A291DFCED3CB26`）。

テストのみの追加なので、DB・ブラウザ・ビルドの再実行は不要と判断した。過去の DB 217 件と本番スモークは**過去の証拠**であり、今回のターンの実行結果ではない。起動した所有コマンドはすべて終了しており、今回サービスやコンテナは起動していない。環境変数の読取、インストール、DB・AI への接続、バックアップ、公開は行っていない。

## 変更したファイル

- 追加: `tests/unit/statement-upload-route.test.ts`
- 追加: `docs/reviews/2026-11-06-upload-route-boundary.md`

既存の未コミットの変更と他の文書（一時停止中の提案予算の文書を含む）には触れていない。
