# 実結合の確認手順（架空データ・Vercel プレビュー）

本物の Supabase、Google ログイン、Claude API をつないで、機能①を最初から最後まで通す手順です。

- **本番データは使いません。** 顧客・明細・マスタは、`supabase/seed/` と `tests/fixtures/` の架空データだけを使います。
- freee への書込とメール送信は、この確認に含みません（まだ実装していません）。
- キーやシークレットは、チャット・PR・このファイルに書きません。Vercel と Supabase の設定画面に直接入れます。

手順は上から順に1つずつ進めます。各段階の最後に「確認」を置いているので、そこで期待どおりかを確かめてから次へ進みます。

## 段階1. 検証用の Supabase プロジェクトを作る

1. Supabase で新しいプロジェクトを作ります。リージョンは Northeast Asia (Tokyo) を選びます。
2. マイグレーションを適用します。リポジトリを手元に置いたパソコンで、次を実行します。

   ```bash
   npx supabase login
   npx supabase link --project-ref <プロジェクトの Reference ID>
   npx supabase db push
   ```

   CLI を使わない場合は、Supabase の SQL Editor に `supabase/migrations/` のファイルを名前順に1つずつ貼り付けて実行します。
3. SQL Editor で `supabase/seed/001_sample_customer.sql` の内容を実行します。架空の顧客2社・口座・マスタ・ルール・過去仕訳が入ります。
   seed の架空ユーザー（`admin@example.com`、`staff@example.com`）は Google でログインできないため、確認には使いません。
4. Project Settings → API Keys（または API）で、次の3つの値を控えます（チャットには書かないでください）。
   - Project URL
   - anon（public）キー
   - service_role キー

**確認**: Table Editor に `customers`（2行）、`freee_masters`、`journal_rules` などが表示されること。

## 段階2. Vercel に環境変数を登録する

1. Vercel でこのリポジトリをインポートします。PR #2 のブランチ `claude/project-thread-xd7oh4` に push すると、プレビューが自動で作られます。
2. Project → Settings → Environment Variables に、次の6つを登録します。対象（Environment）は **Preview** だけにします。

   | 名前 | 値 |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | 段階1で控えた Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 段階1で控えた anon キー |
   | `SUPABASE_SERVICE_ROLE_KEY` | 段階1で控えた service_role キー |
   | `ANTHROPIC_API_KEY` | アプリ用の Claude API キー |
   | `ALLOWED_LOGIN_DOMAIN` | `yuinoyashiro.jp` |
   | `CRON_SECRET` | 十分に長い乱数（例: `openssl rand -hex 32` の出力） |

**確認**: 6つすべてが Preview を対象に登録されていること。

## 段階3. Preview を再デプロイする

環境変数は、登録した後のデプロイから効きます。

1. Project → Deployments で、ブランチ `claude/project-thread-xd7oh4` の最新のデプロイを開き、Redeploy を実行します。
2. デプロイの Domains に表示される、`-git-` を含む **ブランチの URL** を控えます
   （例: `https://<プロジェクト名>-git-claude-project-thread-xd7oh4-<チーム名>.vercel.app`）。
   この URL はブランチに push しても変わらないので、以降の設定にはこれを使います。

**確認**: ブランチの URL を開くとログイン画面（「Google でログイン」）が出ること。Vercel のログインを求められた場合は、Vercel にログインしてから開き直してください。

## 段階4. Google OAuth を設定する

### 4-1. Google Cloud で OAuth クライアントを作る

1. Google Cloud Console → Google Auth Platform を開きます。
2. Audience（対象）で **Internal** を選びます。結乃社の Google Workspace のアカウントだけがログインできるようになります。
3. Clients → Create client で、Application type に **Web application** を選びます。
4. Authorized JavaScript origins に、段階3で控えたブランチの URL を追加します（末尾の `/` は付けません）。
5. Authorized redirect URIs に、Supabase のコールバック URL を追加します。
   この URL は 4-2 の Google の設定画面（Callback URL (for OAuth)）に表示されます。形式は `https://<プロジェクト>.supabase.co/auth/v1/callback` です。
6. 作成後に表示される Client ID と Client Secret を控えます（チャットには書かないでください）。

### 4-2. Supabase に Client ID と Client Secret を登録する

1. Supabase の Authentication → Sign In / Providers（画面によっては Providers）→ **Google** を開きます。
2. Enable Sign in with Google をオンにし、**Client IDs** に Client ID を、**Client Secret (for OAuth)** に Client Secret を入れて Save します。

### 4-3. Supabase にアプリの戻り先を登録する

1. Authentication → **URL Configuration** を開きます。
2. Site URL にブランチの URL を入れます。
3. Redirect URLs に `https://<ブランチの URL のドメイン>/auth/callback` を追加します。

**確認**: Supabase の Google の設定が Enabled になっていること。Redirect URLs に `/auth/callback` で終わる URL が入っていること。

## 段階5. 担当者がプレビューを開けるようにする（Deployment Protection）

プレビューには Vercel の Deployment Protection（Vercel Authentication）がかかっています。Vercel チームのメンバーでない担当者は、そのままでは開けません。次のどちらかで許可します。

- **推奨: 担当者を招待する**
  1. ブランチの URL のデプロイで Share を開き、担当者のメールアドレスを入れて招待します。
     Hobby プランでは、同時に招待できるのは1人までです。
  2. 担当者は招待メールから Vercel アカウントを作り（またはログインし）、ブランチの URL を開きます。
  3. 確認が終わったら、Share の画面で担当者の横の Revoke から許可を取り消します。
- **担当者が許可を求める場合**: 担当者がブランチの URL を開いて Request Access を押すと、Ken にメールが届きます。Share の画面の Access Requests から許可します。

Share の「Anyone with the link」（共有リンク）も使えます。ただしリンクを知っている人なら誰でも保護を通れるので、今回は使いません。

**確認**: 担当者が自分のブラウザでブランチの URL を開き、ログイン画面が出ること。

## 段階6. 初回ログイン（拒否されるのは想定どおり）

Ken（管理者）と担当者が、それぞれ自分のブラウザでブランチの URL を開き、「Google でログイン」を押します。
まだ担当者として登録していないので、「このアカウントは担当者として登録されていません」と表示されてログイン画面に戻ります。
これは想定どおりの動きです。このログインで Supabase の `auth.users` に2人の行ができます。

**確認**: Supabase の Authentication → Users に、2人のメールアドレスが表示されること。

## 段階7. 役割と担当顧客を登録する

SQL Editor で次を実行します。実行する前に、先頭の2行のメールアドレスと表示名を実際のものに書き換えます。
メールアドレスで絞り込むので、seed の架空の担当者は対象になりません。
何度実行しても同じ結果になります（役割と表示名は上書きし、担当の割当は重複させません）。
メールアドレスの大文字・小文字の違いは無視します。seed を適用した後に実行しても、seed の架空ユーザーとは重なりません
（ローカルの DB で、seed 適用後に2回続けて実行して確かめました）。

<!-- register-staff:begin -->
```sql
with people (email, display_name, role) as (
  values
    ('admin-replace-me@yuinoyashiro.jp', 'Ken', 'admin'),
    ('staff-replace-me@yuinoyashiro.jp', '担当者', 'staff')
)
insert into public.staff_members (user_id, email, display_name, role)
select u.id, u.email, p.display_name, p.role
from people p
join auth.users u on lower(u.email) = lower(p.email)
on conflict (user_id) do update
  set display_name = excluded.display_name, role = excluded.role;

-- 担当者に架空の顧客A（サンプル商事株式会社）を割り当てる。管理者は割当なしで全顧客を見られる
insert into public.customer_assignments (customer_id, user_id)
select '10000000-0000-4000-8000-000000000001', s.user_id
from public.staff_members s
where lower(s.email) = lower('staff-replace-me@yuinoyashiro.jp')
on conflict (customer_id, user_id) do nothing;

-- 結果の確認: 2行が出て、役割と担当顧客が期待どおりであること
select s.email, s.display_name, s.role,
       coalesce(string_agg(c.name, '、'), '（割当なし）') as assigned_customers
from public.staff_members s
left join public.customer_assignments a on a.user_id = s.user_id
left join public.customers c on c.id = a.customer_id
where lower(s.email) in (lower('admin-replace-me@yuinoyashiro.jp'), lower('staff-replace-me@yuinoyashiro.jp'))
group by s.email, s.display_name, s.role
order by s.role;
```
<!-- register-staff:end -->

**確認**: 最後の結果が2行（admin が割当なし、staff がサンプル商事株式会社）になること。
1行しか出ない場合は、その人がまだ段階6のログインをしていないか、メールアドレスの書き換えが合っていません。

## 段階8. 再ログイン

2人とも、もう一度「Google でログイン」を押します。

**確認**: 担当者にはサンプル商事株式会社だけが表示されること。管理者にはサンプル商事株式会社とテスト工房合同会社の両方が表示されること。

## 段階9. 機能を確かめる

| # | 誰が | 操作 | 期待する結果 | 確かめる場所 |
| --- | --- | --- | --- | --- |
| 1 | 担当者 | サンプル商事株式会社を開き、口座「サンプル銀行 本店 普通」に `tests/fixtures/statements/bank_generic_sjis.csv`（銀行形式）を取り込む | 5件を取り込む。同じファイルをもう一度取り込むと、5件とも読み飛ばす | 取込結果の表示 |
| 2 | 担当者 | 口座「サンプルカード」に `card_generic_utf8bom.csv`（カード形式）を2回取り込む | 2回目の行は「重複の疑い」になり、トップ画面の「重複の疑い」に件数が出る | トップ画面、顧客の画面 |
| 3 | Ken | 下のコマンドで候補生成を呼ぶ | 未判定の明細に仕訳候補ができる。ルールに一致した明細は AI を呼ばない | 承認画面、ログ照合 A |
| 4 | 担当者 | 1件に理由を入れて保留する。理由が空白だけのときは保留できない | 保留タブに移る | 承認画面、ログ照合 B |
| 5 | 担当者 | 承認・修正・却下・まとめて承認のボタンがないことを確かめる | 操作できない | 承認画面 |
| 6 | 管理者 | 保留した明細を開く | 保留理由・保留者・日時が表示され、1件ずつ承認できる | 承認画面、ログ照合 B |
| 7 | 管理者 | 「高」をまとめて承認し、「中」「低」を1件ずつ修正する | 承認・修正が記録され、承認した内容が過去仕訳に加わる | ログ照合 B・C |
| 8 | 管理者 | 重複の疑いを1件「重複として除外」、1件「別の取引として扱う」 | 除外した明細は消え、別の取引にした明細は未判定に戻る | ログ照合 D |
| 9 | Ken | ログの更新・削除を試す | どれもエラーで拒否される | ログ照合 E |

候補生成の呼び出し（3）は、Ken のパソコンのターミナルで実行します。Vercel Cron は本番デプロイでしか動かないため、プレビューでは手で呼びます。

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" \
     -H "x-vercel-protection-bypass: <バイパス用の値>" \
     https://<ブランチの URL のドメイン>/api/cron/propose
```

`<バイパス用の値>` は、Project → Settings → Deployment Protection の Protection Bypass for Automation で発行します。

結果は、各項目を「成功」「失敗（内容）」「未確認（理由）」に分けて記録します。

## ログ照合（Supabase の SQL Editor）

A〜D は読むだけの SQL です。結果をそのまま貼ってもらえれば照合します。

### A. AI判断ログ（1取引1行）

ルールに一致した明細は `model` が空になります。

```sql
select d.id as decision_id, d.bank_transaction_id, t.description, t.amount, t.status as txn_status,
       d.confidence, d.model, d.prompt_version, d.input_tokens, d.output_tokens, d.cost_usd_micros,
       d.rule_versions_used, d.past_entry_ids, d.ai_unknowns, d.created_at
from public.ai_decisions d
join public.bank_transactions t on t.id = d.bank_transaction_id
order by d.created_at;
```

### B. 人の確認ログ（1操作1行）

```sql
select r.id as review_id, r.ai_decision_id as decision_id, d.bank_transaction_id,
       s.display_name, s.role, r.action, r.bulk, r.reason, r.diff, r.final_entry,
       r.review_seconds, r.created_at
from public.human_reviews r
join public.ai_decisions d on d.id = r.ai_decision_id
join public.staff_members s on s.user_id = r.reviewer_id
order by r.created_at;
```

### C. 承認結果から加わった過去仕訳

```sql
select p.id as past_entry_id, p.ai_decision_id as decision_id, d.bank_transaction_id,
       p.entry_date, p.amount, p.account_item_id, p.tax_code, p.partner_id, p.description
from public.past_journal_entries p
join public.ai_decisions d on d.id = p.ai_decision_id
where p.source = 'approved_proposal'
order by p.created_at;
```

### D. 重複の確認ログ

```sql
select r.id as duplicate_review_id, r.bank_transaction_id, r.duplicate_of_id, t.status as txn_status,
       s.display_name, r.resolution, r.reason, r.created_at
from public.duplicate_reviews r
join public.bank_transactions t on t.id = r.bank_transaction_id
join public.staff_members s on s.user_id = r.reviewer_id
order by r.created_at;
```

### E. 追記専用の確認（更新と削除を別々に試す）

次の4つは **1つずつ** 実行します（まとめて実行すると、最初のエラーで残りが実行されません）。
どれも対象を1行に絞っています。期待する結果は、どれも `... is append-only (UPDATE is not allowed)` または `(DELETE is not allowed)` のエラーです。
もしエラーにならずに実行された場合は、そこで止めて連絡してください。

E-1. AI判断ログの更新

```sql
update public.ai_decisions set ai_reason = 'tamper'
where id = (select id from public.ai_decisions order by created_at limit 1);
```

E-2. AI判断ログの削除

```sql
delete from public.ai_decisions
where id = (select id from public.ai_decisions order by created_at limit 1);
```

E-3. 人の確認ログの更新

```sql
update public.human_reviews set reason = 'tamper'
where id = (select id from public.human_reviews order by created_at limit 1);
```

E-4. 人の確認ログの削除

```sql
delete from public.human_reviews
where id = (select id from public.human_reviews order by created_at limit 1);
```
