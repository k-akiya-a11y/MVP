# CI 検証の手順

[開発ルール](development-rules.md)の「空 DB からの作成と、既存データのある DB からのアップグレードの両方を検証」「CI がない・実行されていない場合は成功とせず未確認」を、再現できる形にした手順。ワークフローは [.github/workflows/ci.yml](../.github/workflows/ci.yml)。

## 現在の状態（2026-10-27 確認。以下の過去記載より優先する）

- **公開済み**: 専用ブランチ `fix/csv-integrity-and-proposal-hold` を `b5df4ac19464c7455f1310d43780d32c7ef354c1` で公開。ドラフト PR [#4](https://github.com/k-akiya-a11y/MVP/pull/4)、base は `claude/project-thread-xd7oh4`（PR2 の head `3908033`）。マージ・デプロイはしていない。
- **CI 成功（この SHA）**: [実行 40457194935](https://github.com/k-akiya-a11y/MVP/actions/runs/40457194935) が completed / success。ログ上のテスト対象は GitHub の PR マージ用テストコミット `a8f27696b976ea04e0ed696cbac5dece12dc80ba`（head `b5df4ac` と base の合成）。
  - `check`（job 122033148339）: lint・型チェック・ユニット（40 ファイル 401 件）・build がすべて成功。
  - `db`（job 122033148582）: PostgreSQL 16.15、shim・全マイグレーション・seed の適用が成功。DB テスト 6 ファイル 113 件が成功。うち `concurrency` 12 件、`upgrade` 9 件を含む。
- **この結果の範囲**: 汎用 PostgreSQL・shim・合成データでの確認。**実際の Supabase（実認証・RLS・Vault）、ブラウザ、実モデル（Claude）での確認ではない。** 下記「まだ残るゲート」は未解決のまま。
- **Windows**: ブロックされた PostgreSQL バイナリーは一度も実行・迂回していない。CI の結果はローカルの Windows 検証の代替ではなく、Linux ランナー上の結果として別に扱う。
- **Vercel（確認済み範囲）**: 認証済みの Vercel プロジェクト `mvp` が GitHub `k-akiya-a11y/MVP`、Root Directory `./` に連携していることを、ユーザー提供のスクリーンショットで確認した。承認を得て、このブランチ名だけに `git.deploymentEnabled: false` を追加した（`main: false` とその他の設定は変更なし）。公開後の読取では最新デプロイは従来の `3908033` のままで、新しいデプロイは観測されなかった。これは確認時点の観測であり、今後も起動しない保証ではない。継続して確認する。
- **ローカルの経緯**: ローカルの Git 資格情報マネージャー経由の push は取り消され、ブランチは作成されていない。既に認証済みの GitHub コネクタが、同一ツリー `54da3b59d0f9cdf263a9bc93a158c2fade3aef46` を公開した。元のローカル 4 コミットは `backup/csv-review-local-20261027` に保全。作業中のローカルブランチはリモートの `b5df4ac` を追跡し、この文書の編集前は clean だった。
- **未確認**: この文書・完成チェックリスト・作業報告の更新だけを含む後続コミットの CI は、まだ確認していない。確認でき次第、その SHA と実行結果を別に追記する。ここに書いた成功は `b5df4ac` に対するものであり、後続コミットには引き継がれない。
- **リリース可否**: 「リリース可能」とは判定しない。残るゲートと Ken の公開承認が必要。

---

**以下は記載時点（公開・CI 実行前）の記録である。** 「未実行」「未コミット」「ガード確認まで push しない」などの記述は当時の状態であり、上の現在の状態で置き換わっている（実環境・ブラウザ・実モデルのゲートを除く）。

**この文書は CI が通ったことの記録ではない。** 追加した検証（アップグレード・2セッション競合）は、記載時点でどの環境でも未実行（Windows の AppControl が実行を拒否しており、迂回していない）。結果は、対象コミットの CI 実行またはローカルの実行ログで別途確認して記録する。（記載時点の記述。`b5df4ac` の CI 結果は上記。）

## 検証の内容

| ジョブ | 内容 |
|---|---|
| `check`（ubuntu-24.04、15分） | 版の記録 → `npm ci --ignore-scripts` → lint → 型チェック → ユニットテスト → build |
| `db`（ubuntu-24.04、20分、Postgres 16.15） | 版の記録・Postgres の版の検査 → 空の DB に土台・マイグレーション・seed を適用（`npm run db:apply`）→ `npm run test:db` |

`test:db` に含まれる、データを守る検証:

- 空 DB へのマイグレーション適用後の RLS・権限・追記専用などのテスト（`tests/db/*.test.ts`）
- **アップグレード**（`tests/db/upgrade.test.ts`）: 下記の固定ベースラインから、使い捨てデータベースに旧版の DB を作り、架空の既存データ（取込・明細・重複の疑い・AI判断・保留と承認の確認・重複確認・ルールと版・メモと版・過去仕訳）を旧版の関数で作る。`20261023000100`〜`000400` だけを適用し、全テーブルの全行・ID・件数・金額・履歴が1行も変わらないことを比べる。そのうえで新しい関数（再実行の判定、未判定のみの AI 記録、ルール・メモの作成）を既存データの上で動かし、既存の行が残ることを確認する
- **2セッション競合**（`tests/db/concurrency.test.ts`）: 取込・AI判断・保留に加え、`create_rule_from_past_candidate` と `create_customer_note` の同じ依頼ID（先の確定後に 23505、先のロールバック後は後続が成功）、別々の依頼ID（待たない）、同じ現在の版から「版 N+1」を同時に追加（後の追加が 23505）。重なりは `sleep` ではなく `pg_stat_activity` / `pg_blocking_pids` でロック待ちを観測して確認し、件数・内容・既存の履歴が変わっていないことを確かめる

## 固定ベースライン（変更しない）

- コミット: `3908033eaeea30f85cec0f1325bd6adb003b43c2`（`tests/db/upgrade.test.ts` の `BASELINE`）
- ベースラインの土台・マイグレーション・seed は `git show` / `git ls-tree` で git のオブジェクトから読む。チェックアウト・リセットはしない
- テストは、ベースライン時点のマイグレーションが作業ツリーで書き換えられていないこと（改行差を除く）、`20261023*` がベースラインに含まれないことを検査する。履歴上のマイグレーションは編集しない。変更は新しいマイグレーションで行う
- ベースラインのコミットが取得できなければ**失敗する**（スキップしない）。CI は `fetch-depth: 0` で全履歴を取得する。ローカルの浅いクローンでは `git fetch --unshallow` が必要
- ベースラインを新しい版に進める場合は、レビューを受けて `BASELINE` と固定する最後のマイグレーション名、この文書を同じ変更で更新する

## 前提（合成データだけ）

- 接続先は `TEST_DATABASE_URL`。テストはホストが `localhost` / `127.0.0.1`、データベース名が `postgres` または `test` を含む名前であることだけを検査する。**これは使い捨てであることの証明ではない**。`db:apply` は指定した接続先をそのまま書き換えるので、使い捨てだと確認できないクラスタには向けない。本番・ステージング、および手元に既にある本番用・実データ入りのローカル DB には絶対に向けない
- 接続先は**この検証専用に新しく作った使い捨ての PostgreSQL クラスタ**で、接続ユーザーは**そのクラスタのスーパーユーザー**とする。`CREATEDB` だけでは足りない。現在の shim（`tests/db/supabase-shim.sql`）が `CREATE ROLE service_role ... BYPASSRLS`（BYPASSRLS の付与にスーパーユーザーが必要）と `auth` スキーマの作成・所有を行い、テストが `SET ROLE`（`anon` / `authenticated` / `service_role`）による権限の切替と、競合テスト後の他セッションの終了（`pg_terminate_backend`）、使い捨て DB の `DROP DATABASE ... WITH (FORCE)` を行うため
- アップグレードと競合のテストは使い捨てデータベース `mvp_upgrade_test_*` / `mvp_conc_test_*` を作り、終了時に削除する。ロール `anon` / `authenticated` / `service_role` はクラスタ共通なので、すでにあれば作成文だけ省く（専用クラスタ以外では、ロールを作ること自体がクラスタ全体への変更になる）
- Windows で実行を拒否されている PostgreSQL のバイナリー（AppControl / Smart App Control）の迂回・解除・再試行は引き続き禁止。承認された実行環境が決まるまで、ローカルの DB 検証は行わない
- 使うデータはすべて架空（seed と各テストの合成行）。顧客の実データ、Supabase・Claude・freee・Google の認証情報は不要で、CI に秘密情報を渡さない。ワークフローは環境変数を出力しない

## 実行コマンド

CI と同じ手順（Linux / macOS。Postgres 16 が `localhost:5432` にあり、`psql` が使えること）:

```bash
npm ci --ignore-scripts
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres   # この検証専用に新しく作った使い捨てクラスタ（スーパーユーザー）専用。既存のローカル DB には使わない
npm run db:apply
npm run test:db                              # 全 DB テスト
npm run test:db -- tests/db/upgrade.test.ts      # アップグレードだけ
npm run test:db -- tests/db/concurrency.test.ts  # 2セッション競合だけ
```

Docker なしで使い捨ての Postgres を起動する場合は `npm run db:test:local`。`db:apply` と `db:test:local` は Bash 前提で、Windows 上で直接動くとは扱わない。Windows では許可された環境で `npm.cmd run test:db -- <テストファイル>` を使う。

ユニットテストなどは `npm run lint` / `npm run typecheck` / `npm test` / `npm run build`。

## CI の挙動

- `ubuntu-24.04` 固定、Postgres は `postgres:16.15`（ダイジェスト固定はしていない）。実際のサーバー版が 16.15 でなければジョブを失敗させる
- 同じ PR の古い実行は新しいコミットで取り消す（`main` への push は取り消さない）。`workflow_dispatch` で手動実行もできる（入力・秘密情報なし）
- 実行環境の版（コミット、Node、npm、psql、Postgres）を通常の Actions ログに出力する。環境変数は出力しない
- 結果は通常の Actions ログだけで確認する。**キャッシュ（`setup-node` の `cache`）とアーティファクト（`upload-artifact`）は使わず**、JUnit やログファイルも作らない。標準の GitHub-hosted の Ubuntu ランナーだけを使い、新しい保存領域・アドオン課金・大きいランナーを使わない
- シェルは `bash`（`-eo pipefail`）、ジョブにタイムアウトあり。使い捨ての Postgres サービスコンテナとアップグレード・競合テストは維持する

## まだ残るゲート（この CI では確認できない）

- 実際の Supabase（実認証・RLS・Vault）に接続した検証環境での確認、Google ログイン、別アカウント（管理者・担当者）での許可と拒否
- ブラウザでの通し確認（ログイン → CSV → 候補 → 承認／修正／却下／保留 → 履歴、重複解決、顧客切替、通信喪失）
- 実モデル（Claude）での精度・誤高確信・費用・遅延の評価。mock の成功で代用しない
- ステージングと本番の分離確認、停止・アプリロールバック・DB 復元の演習、Ken の公開承認

詳細は [完成チェックリスト](completion-checklist.md) と[作業報告の最終ゲート](reviews/2026-10-23-csv-and-hold-fixes.md#最終的に残るゲートすべて未実施)。

## リモートで実行する前の確認（記載時点の記録。現在は公開・CI 実行済みで、上の「現在の状態」を参照）

- 当時の変更は未コミット・未 push のローカルパッチ
- **承認済み**: 公開ソースを専用ブランチ／ドラフト PR に投稿すること。この点は再確認しない
- **費用**: 公開リポジトリでの標準の GitHub-hosted ランナーは無料（[GitHub Actions の課金](https://docs.github.com/en/billing/concepts/product-billing/github-actions)）。新しいアーティファクト・キャッシュ・大きいランナーは使わない
- **残るゲートは、意図しない Vercel デプロイだけ**。現在の `main: false` 設定は、指定していない他のブランチの自動デプロイを止めない。Vercel のダッシュボードは未認証では確認できない。**ガード（ブランチ／Preview のデプロイが起動しないこと）を確認するまで、push も PR 作成もしない**。[deployment-hold.md](deployment-hold.md) の公開保留は維持する
- この文書と CI の追加は、Vercel の設定・課金・セキュリティ・認証を変更しない（Vercel の設定は編集していない）
