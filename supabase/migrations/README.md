# supabase/migrations

DB スキーマのマイグレーション。全テーブルに RLS を付け、判断ログ（ai_decisions・human_reviews・execution_logs）とルール・メモの版は UPDATE・DELETE・TRUNCATE を権限とトリガーで禁止します。

| ファイル | 内容 |
| --- | --- |
| `20261020000100_core_customers.sql` | 担当者・顧客・担当割当、閲覧範囲の関数、追記専用トリガー関数 |
| `20261020000200_masters_wallets_rules.sql` | freee マスタの写し・口座・仕訳ルール（版）・文章メモ（版） |
| `20261020000300_past_entries_transactions.sql` | 過去仕訳・明細の取込・銀行カード明細 |
| `20261020000400_decision_logs.sql` | AI判断・人の確認・実行のログ |
