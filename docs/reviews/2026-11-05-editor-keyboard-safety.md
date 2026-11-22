# 修正フォーム（EntryEditor）のキーボード安全性: 実装前の期待記録

作成: 2026-11-05（テストを書く前の期待。本番コードは未変更）。実装後にこの節を書き直さない。期待が誤っていた場合は、末尾に日時と理由を追記する。

[承認画面のキーボード安全性](2026-11-05-review-keyboard-safety.md) で「保留（今回扱わない）」とした `EntryEditor` の `onKeyDown` を、この記録で扱う。

## 目的

`EntryEditor`（`src/app/customers/[customerId]/review-board.tsx`）の `form` の `onKeyDown` が、日本語入力（IME）の変換中・キー長押し・他で処理済みのキーで、取消（Esc）や保存（Ctrl/Cmd+Enter）を起動しないようにする。

この段階では**テストと期待の記録だけ**を追加する。本番コード・DB・権限・履歴・アクションの意味は変えない。

## 証拠のある不具合（コード上）

`review-board.tsx:486-489` の `onKeyDown` は `e.key` と `ctrlKey` / `metaKey` だけを見ている。

- `Escape` で、無条件に `onCancel()`（`setEditing(null)`）を呼ぶ。IME の変換中に Esc で変換を取り消しただけで、編集中の内容（摘要など）がフォームごと失われ得る。
- `Enter` + Ctrl/Meta で、`valid` なら `onSave()`（`act("correct", editing)`）を呼ぶ。変換確定の途中や長押しでも保存が起動し得る。
- `repeat`、`defaultPrevented`、`isComposing` はいずれも見ていない。

React の合成イベントでは、変換中かどうかは `e.nativeEvent.isComposing` にある（トップレベルの `e.isComposing` とは限らない）。`repeat` と `defaultPrevented` は合成イベント側にもある。

**この不具合は、コードの読取りと合成テストだけが根拠である。実ブラウザ・実 IME での再現は行っていない（未確認）。**

## 具体例（架空データ）

「高」タブの H1 で `e` を押して修正フォームを開き、摘要を「備品」から「編集済み摘要」に変える。勘定科目・税区分は有効（`valid`）。

| 入力 | `nativeEvent` | 現状（コードからの予測） | 期待 |
| --- | --- | --- | --- |
| `Escape` | `isComposing: true` | フォームが閉じ、編集内容が消える | フォームは開いたまま。摘要は「編集済み摘要」のまま。送信 0 回 |
| `Enter` + Ctrl | `isComposing: true` | 保存が 1 回送られる | 送信 0 回。フォームは開いたまま |
| `Enter` + Meta | `isComposing: true` | 同上 | 同上 |
| `Escape` | `repeat: true` | フォームが閉じる | フォームは開いたまま。摘要そのまま |
| `Enter` + Ctrl | `repeat: true` | 保存が送られる | 送信 0 回 |
| `Escape` / `Enter` + Ctrl | `defaultPrevented: true` | 取消・保存が起動する | 何も起きない |
| `Escape`（通常） | なし | フォームが閉じる | **変更なし**（閉じる。送信 0 回） |
| `Enter` + Ctrl / Meta（通常） | なし | 保存が 1 回 | **変更なし**（1 回。`finalEntry.description` は「編集済み摘要」） |

## 予測する挙動（実装フェーズ向け）

1. `onKeyDown` の冒頭で、`e.nativeEvent.isComposing`（`nativeEvent` が無い場合は無視）、`e.repeat`、`e.defaultPrevented` のいずれかが真なら、何もせず戻る。
2. 通常の `Escape` は取消、`Ctrl/Meta + Enter` は（`valid` のとき）保存を、これまでどおり起動する。
3. 送信ガード（送信中・結果不明ロックでの二重送信防止）は変えない。無視されたキーはロックを掴まない。

## 変更しない範囲

- 新しいショートカットの追加・既存の削除。`form` の `onSubmit`、`valid` 条件、ボタンの文言。
- ボード全体の `window` の `keydown`（前回記録で対応済み）。
- DB、権限、`actions.ts`、`submit.ts`、履歴。新しい依存、実ブラウザ、実 DB、認証情報、AI。

## テスト（`tests/unit/review-board-submission.test.ts`）

既存の最小 hook 実装による実コンポーネントの呼出しを使う（ハンドラのソース文字列の検査はしない）。`nativeEvent` を付けた合成イベントを `form.onKeyDown` に渡す補助関数を追加する。既存テストは `nativeEvent` なしで呼んでおり、そのまま動く。摘要を実際に編集してから操作し、フォームの存続と編集内容の保持、`reviewAction` の呼出し回数と引数で確認する。

**実装前の予測:** 変換中・repeat・defaultPrevented の無視テストは現状のコードでは**失敗する**はず。通常の Esc / Ctrl・Meta+Enter の正のテストと、送信ガードのテストは通る見込み。これは実行結果ではなく予測であり、実行して確認するのは Codex。

## 検証状況

未実行。実ブラウザ・IME での検証はしておらず、行ったとは主張しない。

## 追記 2026-11-05: 実装前ベースライン（Codex 実行の報告）

Codex がテスト先行のファイルを単独で実行した結果（Codex がこの作業内で実行し、Claude が記録。Claude 自身は再実行していない）。

- 139 件中 12 件失敗、127 件成功、終了コード 1。
- 失敗の内訳:
  - 変換中 / repeat / defaultPrevented の `Escape` でフォームが閉じた（期待: フォームは残る）。
  - Ctrl / Meta + Enter で `reviewAction` が 1 回呼ばれた（期待: 0 回）。
  - 無視されるはずのキーの後の回復テストで、意図した保存より前に `reviewAction` が 1 回呼ばれていた。
- 上の「予測」は、この範囲では当たっていた。
- これは合成イベントによる再現であり、実ブラウザ・実 IME の証明ではない。

## 追記 2026-11-05: 実装と理由

変更は `review-board.tsx` の `EntryEditor` の `form` の `onKeyDown` の冒頭に 1 行（コメント除く）追加しただけ。

```tsx
if (e.nativeEvent?.isComposing || e.repeat || e.defaultPrevented) return;
```

- `e.nativeEvent?.isComposing`: 変換中かどうかは React の合成イベントではなくネイティブ側にある。既存テストのように `nativeEvent` が無い合成イベントでも落ちないよう、オプショナルチェーンにした。
- `e.repeat` / `e.defaultPrevented`: 合成イベントのものをそのまま見る。
- 早期 return なので、無視したキーは `onCancel` / `onSave` に到達せず、送信ロックも掴まない。
- 通常の `Escape`、`Ctrl/Meta + Enter`、`valid` 条件、`onSubmit`、ボタン、ボード全体の `window` の `keydown` は未変更。テストは変更していない。

**検証状況:** 実装後のテストは未実行。最終結果は Codex の実行待ち。実ブラウザ・実 IME では未検証。

## 最終結果 2026-11-05（Codex による独立検証）

対象: ブランチ `fix/csv-integrity-and-proposal-hold`、HEAD `0763fdf0ae75fc7ae71387c91bf4dd28a35250d7`、作業ツリーの status 項目 76 件。

実際の実行結果（Codex がこの作業内で実行し、Claude が記録。Claude 自身は再実行していない）:

- `node node_modules/vitest/vitest.mjs run --project unit --pool threads`: 終了コード 0。60 ファイル・1106 件すべて成功（41.67 秒）。
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`: 終了コード 0。
- `eslint .`: 終了コード 0。
- `git diff --check`: 終了コード 0（既存の LF/CRLF 警告のみ）。

Codex は、`review-board.tsx:487-488` の実際のガードと、テストのイベント形状を独立にレビューした。

この回は DB、ブラウザ、サービス、実 AI、push を使っていない。

**検証の範囲（重要）:** 上記は、モックしたハンドラ（最小 hook 実装で実コンポーネントを呼び、合成イベントを `form.onKeyDown` に渡す）による単体テストの結果である。実際の OS・ブラウザ・日本語入力（IME）での操作は**実行していない**。ブラウザごとの変換確定タイミング（`keydown` と `isComposing` の前後関係の違い）は**未検証**である。MVP 全体が安全だとは主張しない。

### 引き継ぎ（やさしい説明）

- 修正フォームのキー処理に、コメント1行と条件判定1行を足しただけ。データ移行はない。
- 日本語入力の変換中、キーの長押し、他で処理済みのキーでは、Esc（取消）も Ctrl/Cmd+Enter（保存）も動かない。このとき入力途中の内容（摘要など）はフォームに残り、保存の送信（RPC）も行われない。
- 通常の Esc（閉じる）と Ctrl/Cmd+Enter（保存）は、これまでどおり動く。
- 実際のブラウザ・IME での確認は、まだ行っていない。やるなら、日本語入力で変換中に Esc を押してフォームが残ること、変換確定直後の Enter の挙動を、主要ブラウザで確かめる。

### 未解決

- 実 OS・実ブラウザ・実 IME での動作確認（未実行）。
- ブラウザ固有の変換タイミング（未検証）。
