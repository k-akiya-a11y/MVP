# supabase/migrations

DB スキーマのマイグレーション。全テーブルに RLS を付け、判断ログ（ai_decisions・human_reviews・execution_logs）とルール・メモの版は UPDATE・DELETE・TRUNCATE を権限とトリガーで禁止します。

| ファイル | 内容 |
| --- | --- |
| `20261020000100_core_customers.sql` | 担当者・顧客・担当割当、閲覧範囲の関数、追記専用トリガー関数 |
| `20261020000200_masters_wallets_rules.sql` | freee マスタの写し・口座・仕訳ルール（版）・文章メモ（版） |
| `20261020000300_past_entries_transactions.sql` | 過去仕訳・明細の取込・銀行カード明細 |
| `20261020000400_decision_logs.sql` | AI判断・人の確認・実行のログ |
| `20261022000100_import_wallet_kind_check.sql` | 取込関数で CSV の形式と口座の種類を照合（合わなければ明細を登録しない） |
| `20261023000100_import_batch_identity.sql` | 取込全体の内容識別（DB が計算）。同じ内容の再実行だけを読み飛ばし、別ファイルのキーの重なりは「重複の疑い」にする |
| `20261023000200_record_ai_decision_only_new.sql` | AI判断の記録を未判定（new）の明細にだけ許可し、保留・候補作成済の明細を書き換えない |

| `20261023000300_create_rule_from_past_candidate.sql` | 過去仕訳の候補から「提案中」のルール（親＋版1）を1回で作る関数（SECURITY INVOKER、authenticated のみ実行可）。既存の SELECT/INSERT 権限と RLS をまとめるだけで、テーブル権限・ポリシーは変えない |
| `20261023000400_create_customer_note.sql` | 新しい文章メモを「無効」の版1（親＋版1）で1回だけ作る関数 `create_customer_note`（SECURITY INVOKER、`search_path=''`、authenticated のみ実行可）。状態・版・作成者は固定（引数にない）。既存の INSERT 権限と RLS をまとめるだけで、テーブル権限・ポリシーは変えない。実 DB での適用・`tests/db/note-create.test.ts`・同時実行・既存データありのアップグレードは未検証 |

上の表にない中間のマイグレーション（`20261020000500`〜`20261021000100`）も同じディレクトリにあります。
