# 提案ジョブの「claim 確認後の予算再確認」: DB 結合テストの実行記録

記録: 2026-11-06。対象は `tests/db/proposal-budget.test.ts`（実行可能なテストの変更は無い）。この記録は実際に実行した結果だけを書く。

## 実行前の確認

- 使い捨てのセットアップ、SQL アダプタ、`service_role` での実行、ロールバック、使い捨て DB の削除は、実行前に Codex が独立にレビューした。
- バッチ 1 件で打ち切られる実行と、未判定を使い切る実行（`EXHAUST_BATCH_SIZE`）の期待値は、実行前にこちらで訂正した。

## 実行環境

- 接続先: ローカル `localhost:55439` の使い捨て PostgreSQL 17.11（公式イメージ、digest `sha256:839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5`）。
- コンテナ: `--rm`、データは tmpfs（ホストにデータボリュームなし）。

## 実行コマンド

```
node node_modules/vitest/vitest.mjs run --project db --pool threads tests/db/proposal-budget.test.ts --reporter=verbose
```

## 結果

- 3 件成功・0 件失敗、終了コード 0、所要 479ms。
- 予算 500ms に対し、500/501 の境界で次を確認した。
  - 予算切れ（500/501）: AI を呼ばず、DB に判定を書かず、トランザクション内で新しいリースは 0。続けて別の所有者が順に取得すると、同じ接続・同じトランザクションで 1 件処理され、3 件目のジョブでも重複は無い。
  - 499（通常）: AI 1 回、判定 1 件、提案済み、リース 0。
- 本物: アプリの `runProposalJob` と、PostgreSQL の SQL 関数。

## 追加の検証

- `typecheck --noEmit --incremental false` と `eslint .`: 終了コード 0。`git diff --check`: 0。
- 製品コードのハッシュは変更なし: `4DEFD390874D13F43BC50CF50242379FB63F917C4FE2AB427645B711BD1E3323`。
- 単体テスト全体（1632 件）は前の回の証拠であり、今回は再実行していない。

## 後始末

- 該当する使い捨て DB の数は 0。コンテナは停止済み（`--rm`）で、`ps -a` に名前なし、ポート 55439 の待受は 0。
- 起動したプロセスは終了済み。
- `git status` は 106 件で、既存の変更は保持。`HEAD` は不変。

## この実行が証明しないこと

- SQL アダプタは本番の `SupabaseStore` / PostgREST を通らない。引数の受け渡し・応答の形・HTTP は未検証。
- 文脈、AI、時計は合成（時計は注入）。実際の遅延、接続をまたぐ commit、並行動作、ブラウザ、実 AI は証明していない。
- 実際の DB（本番・共有）、実 AI、費用、バックアップ、push は発生していない。

## 公式情報の確認

- Changelog.md は WebFetch が未対応の種類で失敗。デスクトップ側の fetch は DNS で失敗。関連する公式のローカル文書は読んだ。Supabase の機能・設定の変更は無い。
