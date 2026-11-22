# 承認画面（ReviewBoard）のキーボード操作の安全性: 実装前の期待記録

作成: 2026-11-05（テストを書く前の期待。本番コードは未変更）。実装後にこの節を書き直さない。期待が誤っていた場合は、末尾に日時と理由を追記する。

## 目的

`ReviewBoard`（`src/app/customers/[customerId]/review-board.tsx`）のボード全体のショートカット（`window` の `keydown`）が、ブラウザ・OS・日本語入力（IME）・キー長押しの副作用で、金額に関わる承認・却下・まとめて承認を起動しないようにする。承認は、利用者が明示的に押した単独のショートカットだけで行われる状態にする。

この段階では**テストと期待の記録だけ**を追加する。本番コード・DB・権限・履歴・アクションの意味は変えない。

## 証拠のある不具合

`review-board.tsx:184-204` の `onKey` は次だけを見ている。

- 編集中（`editing`）または対象の `tagName` が `INPUT` / `SELECT` / `TEXTAREA`。
- `e.key` の値。`ctrlKey` / `metaKey` / `altKey` は見ない。`repeat`、`isComposing`、`defaultPrevented` も見ない。`isContentEditable` も見ない。

その結果（本文など入力欄以外にフォーカスがあるとき）、次が起きる。

1. Ctrl+A / Cmd+A（ブラウザの「すべて選択」）で `e.key === "a"` となり `act("approve")` が走る。
2. Ctrl+Shift+A（ブラウザの機能に割当てがあることが多い）で `e.key === "A"` かつ `shiftKey` となり `bulkApprove()` が走る。
3. Alt+X で `act("reject")` が走る。
4. キーを押しっぱなし（`repeat`）にすると、承認・却下・保留・選択切替が繰り返し起動する（送信ガードで二重送信は防がれるが、結果確定後に次の明細へ移ると、続けて次の明細も承認され得る）。
5. IME の変換中（`isComposing`）のキーや、他のハンドラが処理済み（`defaultPrevented`）のキーでも起動する。
6. `contenteditable` の要素（または、その子孫で `isContentEditable` が継承される要素）に入力中でも、`tagName` が `DIV` / `SPAN` などのため起動する。

## 具体例（架空データ）

画面は「高」タブ、現在の明細 H1、`canApprove=true`、`high` の H1〜H3 がある。

| 入力（`key` / 修飾） | 対象 | 現状 | 期待 |
| --- | --- | --- | --- |
| `a` + Ctrl | BODY | 承認が 1 回送られる | 何も送らない。`preventDefault` もしない |
| `a` + Meta | BODY | 同上 | 同上 |
| `A` + Shift + Ctrl | BODY | まとめて承認が送られる（選択済み時） | 何も送らない |
| `x` + Alt | BODY | 却下が送られる | 何も送らない |
| `a`（`repeat: true`） | BODY | 承認が送られる | 何も送らない |
| `a`（`isComposing: true`） | BODY | 承認が送られる | 何も送らない |
| `a`（`defaultPrevented: true`） | BODY | 承認が送られる | 何も送らない |
| `a` | `DIV`（`isContentEditable: true`） | 承認が送られる | 何も送らない |
| `a` | BODY | 承認が 1 回送られる | **変更なし**（承認が 1 回） |
| `A` + Shift（1 件以上選択済み、高タブ） | BODY | まとめて承認が 1 回 | **変更なし** |

修飾付きの `j` / `k` / `e` / `h` / スペースも、同じ理由で何も起こさない（移動・修正フォーム・保留・選択切替も起動しない）。

## 予測する挙動（実装フェーズ向け）

1. ボード全体の `onKey` の冒頭で、次のいずれかなら何もせず（`preventDefault` も呼ばず）戻る。
   - `e.ctrlKey` / `e.metaKey` / `e.altKey`
   - `e.repeat`
   - `e.isComposing`
   - `e.defaultPrevented`
   - 対象が編集可能: 既存の `INPUT` / `SELECT` / `TEXTAREA`、および `isContentEditable` が真（継承を含む。ブラウザは子孫でも真を返す）。
2. 既存の `editing` による抑止は維持する。
3. 文書化済みの単独キーは維持する: `a`（承認）、`x`（却下）、`h`（保留）、`e`（修正）、`j` / `k`（移動）、スペース（選択切替、高タブ）。まとめて承認は **`Shift+A` だけ**（`e.key === "A" && e.shiftKey`、修飾なし）。
4. 役割（`canApprove`）、タブ条件、送信ガード（送信中・結果不明ロック）は変えない。

## 変更しない範囲

- キーボード操作の再設計・新しいショートカットの追加・既存ショートカットの削除。
- 修正フォーム（`EntryEditor`）の `Ctrl+Enter` による保存（`review-board.tsx:485-487`）。サポート済みの操作なので削除しない。
- `EntryEditor` の `onKeyDown`（`Escape` / `Ctrl+Enter`）の IME 変換中・長押しの扱い。具体的な事故の証拠がまだないため**今回は扱わず、保留**とする（未解決として残す。Ctrl+Enter を長押しすると保存が繰り返し呼ばれる可能性はあるが、送信ガードが二重送信を止めるので影響は小さいと見ている。未確認）。
- DB、権限、`actions.ts`、`submit.ts`、結果不明の判定と文面、履歴。
- 新しい依存、実ブラウザ、実 DB、認証情報、AI。

## テスト（`tests/unit/review-board-submission.test.ts`）

既存の最小 hook 実装による実コンポーネントの呼出しをそのまま使う（実装の正規表現検査はしない）。キーイベント生成の `key()` に、`ctrlKey` / `metaKey` / `altKey` / `repeat` / `isComposing` / `defaultPrevented` / `contentEditable`（対象の `isContentEditable`）を任意で渡せるようにする。既定値は従来と同じ（すべて偽）で、既存テストは変えない。

追加するケース:

- 修飾キー（Ctrl / Meta / Alt）付きの `a` / `x` / `h` / `e` / `j` / `k` / スペースと、Ctrl・Meta・Alt 付きの Shift+A: `reviewAction` / `bulkApproveAction` が 0 回、`preventDefault` が 0 回、画面状態（現在の行、修正フォームの有無、選択）が変わらない。
- `repeat` / `isComposing` / `defaultPrevented` の `a`（および選択済みでの Shift+A）: 同上。
- `contenteditable`（`DIV` で `isContentEditable` が真）と、`INPUT` 等の既存の抑止: 同上。`isContentEditable` が偽の `DIV` では動く。
- 正の確認: 単独の `a` は承認が 1 回、選択済みの Shift+A はまとめて承認が 1 回、`preventDefault` が呼ばれる。無視されたキーのあとでも、ロックされず単独キーが使える。
- 役割と送信ガード: `canApprove=false` で修飾付きキーが何も送らず、保留だけは従来どおり送れる。送信中は単独のキーでも二重送信されないまま。

**実装前の予測:** 修飾キー・`repeat`・`isComposing`・`defaultPrevented`・`contenteditable` の抑止テストは、現状のコードでは**失敗する**はず（上の表の「現状」）。正の確認と、役割・送信ガードの既存相当のテストは現状でも通る見込み。この記録は実行結果ではなく予測であり、テストを実行して確認するのは Codex。

## 追記 2026-11-05: テスト先行の実行結果と実装

### テスト先行の実際の結果（Codex が実行、本番コード未変更）

`tests/unit/review-board-submission.test.ts`: 123 件中 **92 件失敗、31 件成功**。

**注意（この数字を「92 件の本番不具合」と読まないこと）:** 失敗には、上の不具合（修飾キー・`repeat`・`isComposing`・`defaultPrevented`・`contenteditable` による承認・却下・保留・修正・移動・選択・まとめて承認の起動）に当たる本物の失敗が含まれる。一方で、テストの `expectIgnored` 自体に誤りがあり、その分も失敗に数えられていた。
- 誤り: 「選択 0 件のとき、まとめて承認ボタンは存在しない」と仮定していた（`btn(WRITE.bulk) !== undefined` が選択有無と一致する前提）。実際のボタンは常に表示され、選択 0 件では「選択した 0 件」で無効になるだけである。このため、何も起きないはずの正しい動作でも失敗していた。
- 失敗 92 件のうち、テストの誤りによるものと本物の不具合によるものの内訳は**未集計**。

### テストの修正（期待は弱めていない）

`expectIgnored` の最後のボタン検査を、「ボタンは常にある。選択なしなら無効、選択済みなら有効のまま」に直した。書込み 0 回、`preventDefault` 0 回、現在の行、修正フォームなし、メッセージなしの検査はそのまま。移動の否定は `j`（H1 → H2 になるはずのキー）で確認できる。H1 での `k` は動いても動かなくても H1 のままなので、単独では移動なしの証拠にならず、`j` が担う。

### 実装（`review-board.tsx` の `onKey` のみ）

先頭で `ctrlKey` / `metaKey` / `altKey` / `repeat` / `isComposing` / `defaultPrevented` のいずれかなら戻り、既存の抑止に `target.isContentEditable` を加えた。ヘルパーや新しい仕組みは追加していない。単独のショートカット、`Shift+A`、`canApprove` とタブ条件、送信ガード、`EntryEditor` の `Ctrl+Enter` は変えていない。

### 検証状況

（この節は実装直後の記録。最終結果は次の節を参照。）

### 保留（今回扱わない）

`EntryEditor` の `onKeyDown`（`Escape` / `Ctrl+Enter`）の IME 変換中・長押しの扱いは、上記のとおり未解決のまま保留。機能追加はしていない。

## 最終結果 2026-11-05（Codex による独立検証）

Codex が次を実行した。

- `node node_modules/vitest/vitest.mjs run --project unit --pool threads`: 終了コード 0。60 ファイル・1090 件すべて成功（30.96 秒）。
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`: 終了コード 0。
- `node node_modules/eslint/bin/eslint.js .`: 終了コード 0。
- `git diff --check`: 終了コード 0。

独立レビューで次を確認した。
- 最小限の早期キーイベントガードであること。
- 単独のショートカット（`a` / `x` / `h` / `e` / `j` / `k` / スペース / `Shift+A`）は変わっていないこと。
- 権限（`canApprove`）と送信ガードが変わっていないこと。
- 修正フォームの `Ctrl+Enter` による保存が残っていること。

**検証の範囲:** 上記はモックによるコンポーネント／単体テストの結果である。実ブラウザ、OS、日本語入力（IME）、DB 統合での検証では**ない**。実 DB、実 AI、外部サービスは使っておらず、push や公開もしていない。

### 引き継ぎ（やさしい説明）

- Ctrl / Cmd / Alt を押しながらのキー、キー長押し（repeat）、日本語入力の変換中、他で処理済みのキー、`contenteditable` 内のキー入力では、承認画面の操作（承認・却下・保留・修正・移動・選択・まとめて承認）は始まらない。
- 意図した単独のショートカット（`a` 承認、`x` 却下、`h` 保留、`e` 修正、`j` / `k` 移動、スペース選択、`Shift+A` まとめて承認）は、これまでどおり動く。
- 実際のブラウザ・IME での動作確認は、まだ行っていない。

### 未解決（引き続き保留）

`EntryEditor` の `Escape` / `Ctrl+Enter` の IME 変換中・長押しの扱いは、**未対応・未確認**のまま。今回の検証で確認したとは主張しない。

### 追記 2026-11-05: 保留項目への後続対応（リンクのみ）

上の `EntryEditor` の保留項目には、後続のコード修正と単体テストが入った。経緯と結果は [修正フォームのキーボード安全性](2026-11-05-editor-keyboard-safety.md) を参照。ただし実 IME・実ブラウザでの確認は引き続き未実施で、上の記述は履歴としてそのまま残す。
