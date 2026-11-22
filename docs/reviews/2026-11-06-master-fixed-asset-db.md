# マスタの attrs.fixed_asset: 厳密な検証の DB 結合テスト: 実装前の期待記録

作成: 2026-11-06（テストを書く前）。実装後にこの節を書き直さない。期待が誤っていた場合は、末尾に日時と理由を追記する。Claude はコマンド・DB・AI・ネットワーク・Git を実行していない。

## 目的

[2026-11-06-master-fixed-asset-validation.md](./2026-11-06-master-fixed-asset-validation.md) で、`supabaseProposalStore.loadCustomerContext` は `attrs.fixed_asset` が存在するのに真偽値でない場合に例外を投げるようになった。ただし検証は偽の Supabase クライアントだけで、**本物の `freee_masters.attrs`（JSONB）が実際にそれらの値を保持できること**、そして**本物の SQL が返した値を本物のストアが拒否し、AI も判断の記録もないまま自分の貸出しだけを返すこと**は示していない。

本番コードを変えずに、使い捨ての PostgreSQL に対する結合テスト（新規 `tests/db/master-fixed-asset.test.ts`）で確かめる。本番コードの変更は、テストが不具合を示した場合に限り、別の作業として扱う。方針（ポリシー）は新しく決めない。既存の検証（`store.ts` の `masterRow`）と `compute.ts` の既存の強制「低」を、そのまま観測する。

## 本物と代役

[2026-11-06-proposal-context-refresh-db.md](./2026-11-06-proposal-context-refresh-db.md) と同じ形を使う（新しい枠組みは作らない）。

| 層 | このテスト |
|---|---|
| `supabaseProposalStore`（zod の検証）・`runProposalJob` | 本物 |
| `claim_pending_proposal_batch` / `renew_proposal_claim` / `release_proposal_claims` / `record_claimed_ai_decision` | 本物の PostgreSQL 関数（service_role） |
| `freee_masters`（JSONB の `attrs`、NOT NULL）・`ai_decisions`（追記専用トリガー）・制約 | 本物。全マイグレーションと seed を適用した、このファイル専用の使い捨て DB。制約は緩めない・`alter` しない |
| `SupabaseClient` | 狭い偽物。`rpc` 4 種と `from(...)` 6 表の読取だけを許可（表・列・メソッドの並びの完全一致）。値はパラメータ。呼出し 1 回ごとに begin → `set local role service_role` → 実行 → commit（本物のコミット） |
| AI | `vi.fn` のみ。実 SDK・ネットワークなし |

## ケース（すべて架空データ。ケースごとに新しい顧客・口座・マスタ・明細を作る）

マスタは勘定科目 105（AI の案が使う科目）の `attrs` に `fixed_asset` と、無関係な `note` / `default_tax_code` を持たせる。

### A. DB が受け付ける不正な `fixed_asset`（ネストした値の不正）

JSONB の値: 文字列 `"true"` / `"false"` / `""`、数値 `1` / `0`、`null`（JSON の null）、オブジェクト `{"x":1}`、配列 `[true]`。

DB は `attrs` の中身を検証する制約を持たない（`attrs jsonb not null` のみ）ので、**DB は受け付ける**と予測する。観測は次の順:

1. 管理接続（第三の接続）で、コミット済みの `attrs -> 'fixed_asset'` が入れた JSON と同じで、`jsonb_typeof` が想定どおりであること。無関係なキーも保たれていること。
2. 本物のストア + `runProposalJob` を実行すると、`loadCustomerContext` が失敗し:
   - `failures` が 1 件で、その明細の ID を持ち、`error` に `fixed_asset` を含む。`processed` は 0、`attempted` は 1。
   - AI は 0 回。`ai_decisions` の行は 0。明細は `new` のまま。
   - RPC の並びは claim → claim（自分の貸出しで空）→ release。`renew` も `record` も呼ばれない。
   - 自分の owner の貸出しは返却済み。**別の owner の貸出し（同じ顧客の 2 件目の明細）は、期限も含めて変わらない**。
   - `attrs` は書き換わっていない。

もし DB が受け付けず SQLSTATE で拒否した場合は、その SQLSTATE を明示的に検証する（予測では起こらない。起きたら予測の誤りとして末尾に追記する）。

### B. 有効な `fixed_asset`（`true` / `false` / 存在しない）

- 実行は成功し、`record_claimed_ai_decision` が実際に 1 件を保存する（`processed` 1）。AI は 1 回（mockAI。`fixed_asset_possible: false` なので、強制「低」の原因はマスタの印だけ）。
- `true`: `confidence` が `low`、`confidence_breakdown.forcedLow` に「固定資産になり得る」を含む。
- `false` と存在しない: `forcedLow` に「固定資産になり得る」を含まない。
- どのケースでも、`attrs`（無関係なキー・`default_tax_code` を含む）は DB 上で変わらない。貸出しは残らず、明細は `proposed`。

### C. 列そのものの不正（ネストの不正とは区別する）

- SQL の NULL（`attrs = null`）: 既存の `not null` により **23502** で拒否される（ストアには届かない）。SAVEPOINT で SQLSTATE を観測する。
- JSON の `null` を列全体の値にした場合（`'null'::jsonb`）: SQL の NULL ではないので DB は受け付ける。ストアの `z.record` が拒否するが、これは `fixed_asset` のキーの検証ではないので、エラーに `fixed_asset` は含まれない。失敗の扱い（AI なし・記録なし・自分の貸出しの返却）はケース A と同じ。
- 列全体の型（配列・文字列など）の網羅はしない。範囲を広げない。

## 隔離と追記専用

`ai_decisions` は追記専用で消せない。各ケースは新しい顧客・口座・マスタ・明細を作り、他のケースのデータを消さない。ケースの開始時に、前のケースが残した `new` の明細を保留に退避し、貸出しを空にし、走査位置を先頭に戻す（`ai_decisions` は触らない）。書込みはすべてコミットされる（ロールバックには頼らない）。観測は管理接続から行い、`ai_decisions` の追記専用トリガーに触れる操作は一切しない（更新・削除を試みない）。

## 安全と後始末

- `validateBaseUrl` が、ローカル（127.0.0.1 / localhost）だけを許す。そのうえで、このファイル専用の使い捨て DB（名前は `mvp_fixed_asset_test_` で始まる）を作り、接続後に `current_database()` がその名前であることを確認する。
- 待ちはすべて上限つき: `within` で実行全体 30 秒、各テスト 60 秒、`beforeAll` 180 秒。
- 後始末: 未確定のトランザクションを戻し、**自分が開いた接続だけ**を閉じ、**自分が作った DB だけ**を `drop`。失敗は握りつぶさず、まとめて投げる。ほかの DB・リソースには触れない。

## 変更しない範囲

- `src/**`、マイグレーション、seed、既存のテスト・ドキュメントすべて。一時停止中の `docs/reviews/2026-11-06-proposal-budget-after-claim.md` は参照も編集もしない。既存の未コミット変更。
- 汎用の PostgREST の再実装・テスト用フレームワーク。偽物は許可表の完全一致だけ。

## 状態

テストは**未実行**。この作業ではコマンドを実行していない。実行はレビュー担当（Codex）が行い、結果はこの下に追記する。

## 既知の限界（実行前に分かっているもの）

- HTTP・PostgREST（JSONB は実際は JSON として返る）・RLS・ブラウザ・実 AI は通らない。
- `attrs` の値の網羅ではなく、上の代表値だけ。`fixed_asset` 以外のキーの検証は追加していない（変更しない）。
- 「DB に不正な `fixed_asset` を直接書ける」ことの是非は別の問題。ここでは、ストアが失敗として閉じることだけを確認する。
- 同時実行の競合は試さない。

## 結果

レビュー担当（Codex）が独立に確認し、次を実行した。

`node node_modules/vitest/vitest.mjs run --project db tests/db/master-fixed-asset.test.ts --pool threads --reporter=verbose`

- 1 ファイル、13 テストがすべて成功。失敗 0。911ms、終了コード 0。

### 観測したこと

- **A（不正なネスト値）**: 8 種の不正な値が、実際に JSONB として保存された。本物のストアは AI・renew・record より前にこれらを拒否した。自分の貸出しは返却され、無関係な別 owner の貸出しと期限は変わらなかった。
- **B（有効な値）**: `true` / `false` / 存在しない、のいずれも判断が実際に保存された。`true` は信頼度が低になり、固定資産の理由を持つ。`false` と存在しない場合は固定資産の理由を持たない。これは、信頼度が高くなることを主張するものではない。
- **C（列そのもの）**: SQL の NULL は `not null` により 23502 で拒否された。列全体の JSON の `null` は DB が受け付けたが、ストアがオブジェクトの形でないとして拒否し、貸出しを返した。
- 本物の RPC（service_role）と本物のストア・`runProposalJob` を通し、コミット済みの状態を別の接続から観測した。

### 通っていない範囲

- AI と HTTP の境界は代役。HTTP・PostgREST・ブラウザ・スタッフの RLS・同時実行は対象外。JSON の型の網羅もしていない。

### 併せて確認したこと

- `tsc --noEmit --incremental false`: 0。`eslint .`: 0。`git diff --check`: 0（既存の CRLF の警告のみ）。
- 単体テスト 1746 件は前のターンで成功。今回は新しい DB テストとドキュメントだけの変更なので再実行していない。
- 使い捨て DB は 0 件、自分が起動したコンテナは停止・削除済み、ポート 55439 のリスナーは 0、セッションは終了。今回、本番コードの編集はない。
- Git は 122 エントリ。既存の差分と一時停止中のドキュメントは保たれている。既存のドキュメントには触れていない。
- 実 DB・実 AI・費用・バックアップ・push・公開は一切ない。

この節は追記のみ。先頭から「既知の限界」までは変更していない（Codex が先頭部分の一致を確認する）。
