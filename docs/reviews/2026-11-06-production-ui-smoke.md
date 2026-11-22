# 本番モードUIスモーク検証記録(2026-11-06)

Codexが独立して完了したスモーク検証の記録。

## 目的(実行前)

`next start` の本番モードで、主要導線と顧客分離を合成ローカル認証のみで確認する。実OAuth・実AI・実DBは使わない。

## 実行前レビュー

- Claudeがリポジトリ外にスクリプトを作成した。
  - パス: `C:/Users/k-aki/Documents/Codex/2026-10-23/task-2/local-ui-validation-20261103/scripts/production-app.mjs`
  - SHA256: `C8EC2D2E4841C600078FCBF281B1048D646056060BBA40D625EE963E50AFA356`
- Codexがレビューしてから実行した。
- build と start に同じ合成ローカルenvを使い、ダミーbuildの再利用を避けた。
- envは明示指定とした。APIキーなし、Anthropic先は loopback の9番ポート(dead loopback)、`.env` のコピーなし。
- ソース116ファイルのハッシュ照合で不一致は0件。

## 環境

- 使い捨ての4サービスComposeを既存configで起動した。公開は loopback の55321/55322のみで、他のローカルIPv4からは到達不可。
- マイグレーション17件適用済み。合成ユーザー3名、顧客2社。
- fixture SQLで proposed 5件と RPC による ai_decisions 5件を投入した。これはCSV/AIの証跡ではない。
- Next 15.5.28 のbuildは成功(compiled 9.8s、静的ページ6、exit 0)。`next start` は 127.0.0.1:3100 で ready(523ms)。

## 結果(ブラウザ IAB)

- 未認証で顧客URLにアクセスすると `localhost:3100/login` へリダイレクトされた。Googleボタンはクリックしていない。
- staff は顧客Aのみ表示された。承認・編集・却下・一括操作のコントロールは表示されなかった。理由付き保留(NORMAL)は保存できた。
- admin は STALE を承認した。BULK-1 は勘定科目を通信費(ID101)から消耗品費(ID102)に修正し、摘要を `本番モード合成 $& $$ $1` に、理由を `合成スモーク確認` に変更した。履歴3件に staff/admin の理由と変更前後が表示された。
- 読み取りスモークでは、合成fixtureのCSV取込記録1件、明細5件、過去品質・ルール・メモの各見出しが読み込まれた。
- 別の staff は顧客Bのみ表示された。顧客Aへの直接アクセスと、履歴・取込・明細・過去品質・ルール・メモの全7ルートは404だった。
- ログアウトhelperは303を返し、アプリはloginへリダイレクトした。

## DB独立検証

- NORMAL: on_hold、hold 1件、past 0件。
- STALE: approved、approve 1件、past 1件。
- BULK-1: approved、correct 1件、past 1件。
- BULK-2/3: proposed のまま、reviews 0件。
- executions: 0件。

## 判定

- 今回のスモーク範囲で新たな不具合は検出されず。プロダクトコードの編集なし。

## 未検証

- 実Google OAuth、実AI、実DB。
- CSV選択・取込、および本実行でのproposal計算。
- 本番モードでのAPI偽造権限、競合、障害応答。
- 新規のルール・メモ書き込み。
- 本番デプロイ、Vercel。
- 先行の単体テスト1746件(72ファイル)と、別途実行した型チェック・lintは前ターンで成功済み。これらとDB 217件は今回再実行していない(以前の証跡)。build内部の型・lintは通過した。

## クリーンアップ

- ログアウトとタブのクローズを確認した。
- next/helper は意図したCtrl-Cで終了した(terminal exit 1)。
- `compose down --volumes` と `cleanup-files.mjs` は終了コード0。
- コンテナ・ボリューム・ネットワークはなし。
- 3100/3101/3102/55321/55322/55323 のリスナーは0。生成したapp/.local/seed/csv/migrationsは削除した。

## リポジトリ状態

- 既存のdirtyエントリ126件は保持し、本レポート追加で127件(想定どおり)。
- `git diff --check` は本レポート作成前も作成後も成功。
- ブランチ: `fix/csv-integrity-and-proposal-hold`
- HEAD: `0763fdf0ae75fc7ae71387c91bf4dd28a35250d7`
- 一時停止中の文書のSHA256は不変: `3142146EC1895AF7400257E3013815B9A3AD06D253A3A044A2A291DFCED3CB26`

## 範囲外

- 費用発生、バックアップ、push、デプロイは行っていない。
- リリース全体の完了を示すものではない。
- スクリーンショットは保存していない。
