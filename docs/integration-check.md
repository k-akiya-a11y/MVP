# 実結合の確認手順（架空データ）

本物の Supabase・Google ログイン・Claude API をつないで、機能①を最初から最後まで通す手順です。
**本番データは使いません。** 顧客・明細・マスタはすべて `supabase/seed/` と `tests/fixtures/` の架空データです。
freee への書込とメール送信はこの確認に含みません（まだ実装していません）。

## 準備

1. 検証用の Supabase プロジェクト（東京リージョン）を作り、マイグレーションと seed を適用する
   （`npx supabase link` → `npx supabase db push` → `supabase/seed/001_sample_customer.sql` を SQL エディタで実行）。
2. Supabase Auth で Google プロバイダを有効にし、許可するリダイレクト URL にアプリの `/auth/callback` を登録する。
3. 自社ドメインの Google アカウントを2つ用意する（管理者＝Ken、担当者＝もう1名）。2つとも一度ログインして
   `auth.users` に行を作り、次の SQL で役割と担当顧客を登録する（メールアドレスは実際のものに置き換える）。

   ```sql
   insert into public.staff_members (user_id, email, display_name, role)
   select id, email, '管理者', 'admin' from auth.users where email = 'admin@example.jp';
   insert into public.staff_members (user_id, email, display_name, role)
   select id, email, '担当者', 'staff' from auth.users where email = 'staff@example.jp';
   insert into public.customer_assignments (customer_id, user_id)
   select '10000000-0000-4000-8000-000000000001', user_id from public.staff_members where role = 'staff';
   ```

   seed の架空ユーザー（`00000000-…0001`・`…0002`）は Google ログインできないので、確認には使わない。
4. アプリの環境変数（`.env.example` のうち次のもの）を設定して起動する（Vercel のプレビュー環境、またはローカル）。
   `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`ANTHROPIC_API_KEY`、
   `ALLOWED_LOGIN_DOMAIN`、`CRON_SECRET`。

## 確認すること

| # | 誰が | 操作 | 期待する結果 | 確かめる場所 |
| --- | --- | --- | --- | --- |
| 1 | 担当者 | Google でログイン | 担当顧客（サンプル顧客A）だけが一覧に出る。顧客Bは出ない | トップ画面 |
| 2 | 担当者 | `tests/fixtures/statements/bank_generic_sjis.csv` を取込 | 5件取込。同じファイルをもう一度取り込むと5件読み飛ばし | 取込結果、`statement_imports` |
| 3 | 担当者 | `card_generic_utf8bom.csv` を2回取込 | 2回目は「重複の疑い」になり、トップ画面の「重複の疑い」に件数が出る | トップ画面、`bank_transactions.status` |
| 4 | — | `GET /api/cron/propose`（`Authorization: Bearer <CRON_SECRET>`） | 未判定の明細に仕訳候補ができる。ルール一致の明細は AI を呼ばない | `ai_decisions`（model・prompt_version・トークン数・費用） |
| 5 | 担当者 | 1件を理由付きで保留。理由が空白だけだと保留できない | 保留タブに移る | `human_reviews`（action=hold、reason、reviewer_id） |
| 6 | 担当者 | 承認・修正・却下・まとめて承認のボタンがない | 操作できない | 承認画面 |
| 7 | 管理者 | Google でログインし、保留した明細を開く | 保留理由・保留者・日時が表示される。1件ずつ承認できる | 承認画面、`human_reviews` |
| 8 | 管理者 | 「高」をまとめて承認、「中」「低」を修正 | 承認・修正が記録され、承認内容が過去仕訳に加わる | `human_reviews`（bulk・diff・review_seconds）、`past_journal_entries` |
| 9 | 管理者 | 重複の疑いを「重複として除外」 | 明細が除外される | `duplicate_reviews` |
| 10 | — | ログを UPDATE・DELETE してみる | 拒否される | SQL エディタ |

結果は「成功」「失敗（内容）」「未確認（理由）」に分けて記録する。
