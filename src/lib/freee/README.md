# src/lib/freee

freee会計API のクライアント（読み取り）とトークン管理、読み取り同期。書込の呼出しは置かず、src/lib/execution からのみ行います（未実装）。設計は [docs/design.md](../../../docs/design.md) 3章・6章。

| ファイル | 役割 |
| --- | --- |
| `api.ts` | 読み取り専用のクライアント（GET だけ）。応答は zod で検証。呼出し回数の予算つき。fetch を差し替えてテストする |
| `oauth.ts` | 認可 URL、認可コード・リフレッシュトークンからのトークン取得、CSRF 対策の state（署名つき cookie） |
| `tokens.ts` | アクセストークンを得る唯一の入口。更新は DB のロック（所有者と期限）を取った処理だけが行う |
| `token-store.ts` | トークンの保存先（Vault。service_role の関数だけ） |
| `sync.ts` | freee の応答 → マスタの写し・過去仕訳の行への変換と、月単位の進め方 |
| `run.ts` | 1顧客分の同期（マスタ → 過去仕訳）と実行記録 |
| `page-load.ts`・`admin.ts` | 「freee 連携」画面のデータと、管理者の判定 |

DB は `supabase/migrations/20261125000100_freee_connections.sql`。テストは `tests/unit/freee-*.test.ts`（偽の freee）と `tests/db/freee-connections.test.ts`。本物の freee（テスト事業所）での確認は未実施。
