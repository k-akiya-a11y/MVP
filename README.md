# 結乃社 AI経理MVP

結乃社の経理BPO業務をAIで高生産性化するためのMVPです。銀行・カード明細や証憑から仕訳候補を作り、確信度に応じて人の承認に回し、承認されたものだけを freee や Gmail（下書き）に反映します。

- 技術設計書: [docs/design.md](docs/design.md)
- MVP開発依頼書: [docs/requirements.md](docs/requirements.md)
- 開発ルール（Claude Code / Codex 共通）: [CLAUDE.md](CLAUDE.md) ＝ [AGENTS.md](AGENTS.md)

## MVPの機能

1. 銀行・カード明細 → 仕訳候補
2. 証憑 → 仕訳候補
3. 請求データ → 請求書作成
4. 請求書 → メール下書き（自動送信しない）
5. 入金確認 → 未入金一覧

開発順序は「計測とデータ準備 → ① → ⑤ → ③④ → ②」です。

## 基本方針

- AI は提案を返すだけで、外部への書込は人が承認した後にプログラムが実行します。
- Phase 1 では仕訳確定・請求書送信・会計データ変更・金銭処理はすべて人の承認を通します。
- メールは下書きまで。送信は担当者が Gmail で行います。
- AI の判断と人の確認はすべて判断ログに残します。

## 技術スタック

Next.js（TypeScript, Vercel）／Supabase（Postgres, 東京リージョン）／Claude API／freee会計API・freee請求書API／Gmail API・Google Drive API

## 状態

現在は初期構成（ドキュメントとディレクトリの骨組み）のみです。アプリの初期化と機能実装はこれからです。セットアップ手順と実行方法は、アプリ作成後に [CLAUDE.md](CLAUDE.md) の「実行・テスト方法」に追記します。
