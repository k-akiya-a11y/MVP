# src/app

Next.js App Router。承認画面（明細・証憑・AI案・根拠を並べ、承認・修正・保留をキーボードで操作）と API ルートを置きます。

| パス | 内容 |
| --- | --- |
| `/` | 担当顧客の一覧と確認待ちの件数 |
| `/customers/[customerId]` | 明細CSVの取込と承認画面（高・中・低・保留のタブ） |
| `/login`、`/auth/callback` | Google ログイン（`ALLOWED_LOGIN_DOMAIN` のアカウントで、担当者として登録済みの人だけ） |
| `/api/customers/[customerId]/statements` | 明細CSVのアップロード |
| `/api/cron/propose` | 未判定の明細に仕訳候補を作る（Vercel Cron、`CRON_SECRET` が必要） |
