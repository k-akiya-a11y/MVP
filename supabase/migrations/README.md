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
| `20261024000100_proposal_scan_cursor.sql` | 仕訳候補ジョブの走査位置（1行の表 `proposal_scan_cursor`）と、明細ごとの作業の貸出し（表 `proposal_leases`：所有者と期限）。関数は4つ（すべて SECURITY INVOKER、`search_path=''`、service_role のみ実行可。PUBLIC・anon・authenticated から revoke）: `claim_pending_proposal_batch(p_limit, p_owner, p_lease_seconds)`（位置の行ロック・貸出し中を除く未判定の選択・貸出しの記録・位置の更新を1トランザクションで行う。1回200件まで、貸出しは60〜3600秒）、`renew_proposal_claim`（AI 呼出し前の所有の確認と延長）、`release_proposal_claims`（失敗・中止・未着手の返却。自分の貸出しだけ）、`record_claimed_ai_decision`（貸出しの所有者だけが記録でき、記録は従来の `record_ai_decision` の「new にだけ」を通る）。失敗して new のまま残る明細が先頭に溜まっても後ろが飢えないよう巡回し（アプリは `p_limit = 1` で判定の直前に1件ずつ借りるので、位置は実際に判定を始めた明細の分だけ進み、時間の予算で止まっても未着手の明細を飛ばさない。SQL は変えない）、折返し・同時実行でも記録前の明細を別の実行に渡さない。期限切れの貸出しは次の実行が引き継ぎ、古い所有者の記録は拒否される（期限が切れても古い実行の AI 呼出しが続いていれば AI の二重呼出しは起こりうる。アプリは貸出し 600 秒 > 関数の最大実行時間 300 秒で避ける）。**アプリのジョブ（`src/lib/proposals/store.ts`）はこれらの関数に依存し、AI判断の記録も `record_claimed_ai_decision` 経由になるため、アプリより先に適用が必要**（適用前の旧アプリは `record_ai_decision` を直接呼ぶので動き続けるが、新アプリは動かない）。追加のみ（既存の表・関数は変更しない）。**未適用・未コミット**。実 DB での適用、`tests/db/proposal-claim.test.ts`（2セッションの待ちを含む）と `tests/db/upgrade.test.ts`（旧ベースラインからのアップグレード、既存行不変、増えるのは内部の2表だけ、RLS・権限、実際の関数の動作）は**書いただけで未実行** |

| `20261105041046_reject_duplicate_hold.sql` | `record_human_review` を再作成し、**すでに保留中（`on_hold`）の明細への保留（`p_action = 'hold'`）を拒否**する（`P0001`、文言「この明細はすでに保留中です。管理者の確認を待ってください」）。判定は明細の `for update` ロックと「より新しい仕訳候補」の確認のあとで、拒否は例外なので確認ログも `review_seconds` も増えない。保留 → 承認・修正・却下は従来どおり通す。変更はこの1か所だけで、権限・閲覧範囲・まとめて承認の制限・追記専用・`normalize_final_entry`・所有者・`search_path=''`・実行権限（authenticated のみ）は 20261020000700 と同じ。**既存の履歴は変更・削除しない**（既に重複した保留の行の修復は別作業）。画面の挙動は変えない（`on_hold` の行で保留を隠す表示のまま。別タブ・古い画面からの保留をDBが拒否するだけ）。アプリの `src/lib/review/submit.ts` の既知の拒否の表にこの組を追加済み（適用前の旧DBと組み合わせても、組が出ないだけで動く）。**ライブ DB には未適用・未コミット**。合成（使い捨て）DB では適用済みで、検証に通過（Codex の報告。ライブ DB・実 AI・push・公開は未使用）: `tests/db/concurrency.test.ts` 22 件通過、`tests/db/upgrade.test.ts` 13 件通過（ベースラインの `service_role` 実行権の想定と、PostgreSQL の `proconfig` の `search_path=""` の厳密な期待を訂正したうえで）、単体テスト 55 ファイル 781 件通過、`tsc --noEmit --incremental false` と lint は exit 0。CLI（3.0.0）の `migration new` は通常の昇格実行で成功し、ACL の変更はなし。関数の変更は `on_hold` への保留の拒否だけ（元の本体のその他の部分は不変）。ライブ DB への適用は別途必要 |
| `20261125000100_freee_connections.sql` | freee との接続（読み取りだけ）。表 `freee_connections`（顧客ごとの事業所 ID・状態・期限。トークンは Vault に入れ、表には Vault の ID だけ。authenticated には秘密でない列だけを列の権限で見せ、RLS で担当顧客に限る。service_role も表には直接書けない）、`freee_sync_state`（同期の進み具合）、`freee_sync_runs`（実行記録）。`past_journal_entries.bank_description_source` 列を追加。関数（すべて SECURITY DEFINER、`search_path=''`、service_role のみ実行可）: `save_freee_connection`（事業所の一致と管理者を確かめて保存）、`get_freee_access_token`、`begin_freee_token_refresh`・`complete_freee_token_refresh`・`fail_freee_token_refresh`（所有者と期限つきのロックで更新を1つにする）、`sync_freee_masters`（attrs を重ね、なくなった値は使用不可に）、`apply_freee_past_entries`（取引ごとに上書きし、進み具合を同じトランザクションで保存）。**Supabase Vault（`vault` スキーマ）が必要**。テストの土台 `tests/db/supabase-shim.sql` に Vault の最小限の写しを追加した。`tests/db/freee-connections.test.ts` は書いただけで、この PC では未実行（CI で確認する）。`tests/db/upgrade.test.ts` の固定ベースラインからのアップグレードには、このマイグレーションを含めていない（ベースラインの土台に Vault がないため） |

上の表にない中間のマイグレーション（`20261020000500`〜`20261021000100`）も同じディレクトリにあります。
