# マスタの fixed_asset が不正な値でも false になり、固定資産の強制「低」が外れる: 実装前の期待記録

作成: 2026-11-06（コード修正前の期待の記録。実装後にこの節を書き換えない。誤りがあれば末尾に日時と理由を追記する）。Claude はコマンド・DB・AI を実行していない。

## 目的

`src/lib/proposals/store.ts` の `masterRow` は `attrs` を `z.record(z.string(), z.unknown())` として読み、`loadCustomerContext` は `fixedAsset: m.attrs.fixed_asset === true` で写す（`store.ts:98,208`）。`fixed_asset` が存在しても `true` 以外（文字列 `"true"`、数値 `1`、`null`、オブジェクト、配列など）は、エラーにならず黙って `false` になる。`compute.ts:77` の「固定資産になり得る」強制「低」は `account?.fixedAsset` に依存するので、マスタの印が壊れていると、固定資産の科目が通常の確信度で提案される。必須の安全ガードが、不正な入力で静かに外れる。

## 期待する動作（修正後）

1. `fixed_asset` が `attrs` に**存在する**とき、値が厳密な真偽値（`true` / `false`）でなければ、`loadCustomerContext` は写す前に例外を投げる。
2. 例外の文言は項目名 `fixed_asset` を含む（zod の検証エラーとして、パスにも `fixed_asset` が出る）。
3. 変換はしない: `Boolean(...)`、文字列 `"true"`/`"false"`、数値 `1`/`0` の解釈、`null` を `false` とみなす扱いはしない。
4. `fixed_asset` が存在しない → `fixedAsset: false`（従来どおり）。`true` → `true`。`false` → `false`。
5. `fixed_asset` 以外の `attrs`（未知のキー、`default_tax_code` を含む）は従来どおり受け入れ、検証を追加しない。
6. 失敗は閉じる: `runProposalJob` は、文脈の読込の例外を失敗として数える（既存の動作）。その明細には AI を呼ばず、`recordDecision` もしない。借りた明細は `releaseClaims` で返す。

## 例（架空データ）

| `attrs` | 現状（予測） | 期待 |
| --- | --- | --- |
| `{}` | `fixedAsset: false` | 同じ |
| `{ fixed_asset: true }` | `true` | 同じ（強制「低」） |
| `{ fixed_asset: false }` | `false` | 同じ |
| `{ fixed_asset: "true" }` | `false`（黙って） | 例外（`fixed_asset`） |
| `{ fixed_asset: 1 }` | `false` | 例外 |
| `{ fixed_asset: null }` | `false` | 例外 |
| `{ fixed_asset: {} }` / `[]` / `"false"` / `0` | `false` | 例外 |
| `{ other: "x", default_tax_code: 21 }` | 受け入れ | 同じ |

## 例外

- 不正な `fixed_asset` を持つマスタ1行があれば、その顧客の文脈全体を読めない（部分的に捨てて続けない）。同じ顧客の明細は、マスタが直るまで失敗として数えられ、`new` のまま残る。
- `available = false` のマスタ行は、そもそも読み込まれない（既存のクエリ条件）ので、この検証の対象外。

## 変更しない範囲

- `default_tax_code` の扱い（数値でなければ `undefined`。今回は変更しない）。
- ほかのマスタ項目、`kind` / `freee_id` / `name` の検証。
- 会計上の分類の追加・推測。`compute.ts`、`propose.ts`、`run.ts`、DB、マイグレーション、UI、依存関係。
- 既存の未コミット変更、`docs/reviews/2026-11-06-proposal-budget-after-claim.md`（触らない）。

## 実装方針（最小）

`masterRow.attrs` に `superRefine` を足し、`fixed_asset` が自身のプロパティとして存在し `typeof !== "boolean"` なら、パス `["fixed_asset"]` で issue を追加する。`m.attrs.fixed_asset === true` の写しはそのまま（検証後は真偽値だけが来る）。

## テスト（今回追加）

`tests/unit/proposal-store.test.ts` に追記。合成データのみ。Supabase クライアントとストアの RPC をモックし、**実際の** `supabaseProposalStore` と `runProposalJob` を通す（検証や写しはテスト側で再実装しない）。

- 不正（文字列 `"true"`/`"false"`、数値 `1`/`0`、`null`、オブジェクト、配列）: `loadCustomerContext` が `fixed_asset` を含む理由で拒否される。
- 有効: 存在しない・`true`・`false` と、無関係な `attrs` が受け入れられ、`fixedAsset` が `undefined`→`false` / `true` / `false` に写る。
- 実行: `true` の固定資産科目で AI の案が `forcedLow` に「固定資産になり得る」を持つ。`false` / 存在しないでは持たない。
- 失敗: 不正値では AI 未呼出し、`record_claimed_ai_decision` 未呼出し、`failures` に `fixed_asset`、`release_proposal_claims` に借りた ID。

## この記録が主張しないこと

- テストの実行結果（赤・緑の確認は Codex が行う）。実 DB の `freee_masters.attrs` に不正値が実際にあること。

## 追記: 検証結果と Codex レビュー（2026-11-06）

上の節は書き換えていない。以下は実装後の結果の追記である。

### 初回の実行（無効）

- Codex の最初の unit 全体の実行と、絞り込みの実行は、どちらも中断され exit 1 だった。
- 原因は、テストに足した `from` / `range` のモックが、同じ行を無限に返し続けたこと。製品コードの欠陥ではない。
- これらは合格として数えない。信頼できる完了件数もない。

### 修正（テストのページ送りのみ）

Claude は、テストのページ送りだけを直した。実際のスライスを返し、最後は空ページを返す。製品コードは変えていない。

### 最終の実行結果

- 対象: `proposal-store.test.ts` は 35 テスト合格、272ms、exit 0。
- unit 全体: 72 ファイル / 1746 テスト合格、所要 31.55s、exit 0。コマンドは `node node_modules/vitest/vitest.mjs run --project unit --pool threads --reporter=dot`。新しい回帰テストは 23 件。
- `tsc --noEmit --incremental false` と `eslint .` は、どちらも exit 0。
- `git diff --check` は、最後のモック変更の前に合格した。最後の確認は Codex が行う。

### Codex のレビュー

- `attrs.fixed_asset` が存在するときは `typeof` が boolean であることを要求する。存在しない場合は従来どおり `false`。`true` は `true` に写り、強制「低」の理由が付く。
- 不正な 8 種類は、読込と実行のどちらでも拒否される。AI の呼出しも `recordDecision` もない。
- 所有者で絞った release RPC は、モックでのみ確認した。

### 範囲と主張しないこと

- 今回の実行で、SQL・DB・ブラウザは実行していない。実際の claim の解放、RLS、DB の網羅は主張しない。
- `fixed_asset` 以外の `attrs` と `default_tax_code` の扱いは変えていない。マスタ情報が欠けている場合の分類も、すべて変わらない。
- 不正な現行マスタがあると、その顧客の文脈は、直るまで読み込みに失敗する。黙って「false」に落とすことはしない。
- 自分で開始したセッションはすべて終了した。合成サービスは起動していない。
- 既存の `docs/` の一時停止中の文書は、ハッシュが保存されたままである。status は 120 件で、ブランチの HEAD も変わっていない。
- 実 DB、AI、費用、バックアップ、push、デプロイは行っていない。
