# 本番公開の保留と解除の手順（Vercel）

本番利用の承認より先に、コードを main へ統合できるようにするための手順です。設定変更は Ken の判断で行い、ここに日付と結果を残します。

## 前提

- Vercel プロジェクト `mvp` の Production 環境は Git の `main` を追跡している（Settings → Environments → Production → Branch Tracking。Ken 確認、2026-10-22）。
- そのままでは main へのマージで本番デプロイが始まり、`vercel.json` の Cron（毎日 22:00 UTC = 07:00 JST に `/api/cron/propose`）が本番で有効になる。

## 何を止め、何を止めないか

| 案                                                       | 止めるもの                                                                               | 止めないもの                                                                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. `vercel.json` の `git.deploymentEnabled.main = false` | main へのコミット（マージ）を引金にした**自動**デプロイ。main のデプロイ自体が作られない | 他ブランチの Preview デプロイ、ダッシュボードの Redeploy / Promote、Vercel CLI（`vercel --prod`）、Deploy Hook による手動デプロイ、すでに公開中のデプロイ |
| D. ダッシュボードの Cron Jobs → Disable Cron Jobs        | 本番デプロイでの Cron の定期実行（再デプロイ・ロールバックをまたいで無効のまま）         | デプロイそのもの、`/api/cron/propose` を手で呼ぶこと（`CRON_SECRET` が合えば動く）、既存の公開                                                            |

A と D はどちらも「既存の公開や手動の操作まで止めるもの」ではありません。機能①の本番利用は未承認のまま、main への統合だけを進めるための措置です。

## 保留の手順

1. **案 A（リポジトリ）**: `vercel.json` に次を追加する。`framework`・`regions`・`crons` は維持する。

   ```json
   "git": { "deploymentEnabled": { "main": false } }
   ```

   - PR のブランチで CI（lint・型チェック・ユニットテスト、マイグレーション・RLS テスト）と Preview が正常なことを確認してからマージする。
   - この設定は、マージ後の main にある `vercel.json` で評価される。

2. **案 D（ダッシュボード、Ken）**: Vercel → mvp → Settings → Cron Jobs →「Disable Cron Jobs」。無効のままでも cron は一覧に残る。
3. **マージ後の確認**: Vercel → mvp → Deployments に、そのマージコミットの Production デプロイが**作られていない**ことを確認する。作られていた場合は、次の「想定外の Production デプロイが作られた場合」に従う。

## 想定外の Production デプロイが作られた場合

案 A が効いていない、または手動操作で Production デプロイができてしまった場合の手順。止める操作と、今後のビルドを抑える操作を分けて行う。

1. **確認**: Deployments でそのデプロイを開き、対象コミット（SHA とブランチ）、環境が Production であること、状態（Building / Ready / Error / Canceled）を確認して記録する。
2. **ビルド中なら中止**: 状態が Building（Queued を含む）なら、そのデプロイの画面で「Cancel Deployment」を選び、状態が Canceled になることを確認する。中止したデプロイは公開されない。
3. **公開済みなら公開停止（Ken）**: 状態が Ready で本番として公開されているなら、Ken が Vercel → mvp → Settings → General の「Pause Project」で公開を止める（プロジェクト名を入力して確定。Owner / Member か Project Administrator の権限が要る）。停止中は本番 URL へのアクセスが 503（DEPLOYMENT_PAUSED）になる。再開は同じ場所の「Resume Project」で、再デプロイは不要（[公式の停止手順](https://vercel.com/docs/projects/managing-projects#pause-a-project-from-the-dashboard)）。
4. **今後のビルド抑止（別の操作）**: 公開停止とは別に、Settings → Build and Deployment → Ignored Build Step を「Only build preview」にして、main 側のビルドを作らせない。これは Production デプロイを CANCELED として記録するだけで、すでに公開中のデプロイは止めない（止めるのは手順 3）。あわせて `vercel.json` の案 A の設定が main に入っているかを確認する。
5. **記録**: 対象コミット、状態、行った操作、誰が、いつを下の「記録」に残す。

## 解除（本番公開）の手順

本番利用の承認の後に行う。順番を守る。

1. Settings → Deployment Protection で、本番に掛けるアクセス保護（Vercel Authentication の対象）を決めて確認する。
2. Settings → Environment Variables で、Production に必要な変数（名前と適用先）が揃っていることを確認する。値は共有しない。`CRON_SECRET` が無いと Cron は 401 で止まる。
3. `vercel.json` から `git.deploymentEnabled` の行を外すコミットを main に入れる。**このコミットが、機能①を含む本番デプロイの引金になる。**
4. Deployments で Production デプロイが Ready になり、アクセス保護が効いていることを確認する。
5. Cron の再有効化（Settings → Cron Jobs → Enable）は、本番で定期処理を動かす判断として**別に**決める。

## 記録

| 日付       | 操作                                           | 誰が   | 結果                                                    |
| ---------- | ---------------------------------------------- | ------ | ------------------------------------------------------- |
| 2026-10-22 | 案 A を PR #2 に追加（`vercel.json`）          | Claude | コミット `0b3fe77`。CI と Preview の結果は PR #2 に記載 |
| 2026-10-22 | 案 D（Cron 無効化）                            | Ken    | （実施後に記入）                                        |
|            | マージ後に Production デプロイが無いことを確認 |        | （実施後に記入）                                        |

## 出典（Vercel 公式）

- [Git Configuration: git.deploymentEnabled](https://vercel.com/docs/project-configuration/git-configuration)
- [Can you deploy based on tags/releases on Vercel?](https://vercel.com/kb/guide/can-you-deploy-based-on-tags-releases-on-vercel)
- [Project settings: Ignored Build Step](https://vercel.com/docs/project-configuration/project-settings)
- [Managing projects: Pause a project from the dashboard](https://vercel.com/docs/projects/managing-projects#pause-a-project-from-the-dashboard)
- [Managing deployments](https://vercel.com/docs/deployments/managing-deployments)
- [Managing Cron Jobs: Disabling Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- [Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication)
