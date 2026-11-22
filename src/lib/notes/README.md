# src/lib/notes

顧客別の文章メモ（`customer_notes` / `customer_note_versions`、設計書5章）の確認・編集。メモは AI が仕訳候補を作るときの**参考データ**で、版管理し、上書きしません。

## 既存メモの確認・編集（`/customers/[customerId]/notes`）

保存済みメモの現在の版（`current_customer_notes`）を一覧し、選んだメモのタイトル・本文を直して、「有効」または「無効」の**新しい版として保存**する範囲です。

| ファイル | 役割 |
| --- | --- |
| `editor-schema.ts` | 入力検証（純粋関数、zod strict）。ID・版（1〜int32 − 1）・状態（active / inactive）。タイトル・本文は入力のまま保ち、長さの上限は設けない。「有効」にするときだけ空白だけを拒否 |
| `editor-load.ts` | 画面用の読込（読取専用）。顧客・親メモ・現在の版を顧客で絞って全ページ読み、他の顧客の行・親のない版・重複・形式の不正は失敗。失敗は固定文（`NoteEditorLoadError`） |
| `editor-submit.ts` | 保存のサーバー側処理（`submitNoteVersion`）。`customer_note_versions` への INSERT だけ |
| `editor-draft.ts` | 画面の入力欄と保存の入力の変換。触っていない欄は保存済みの値をそのまま送る |
| `src/app/customers/[customerId]/notes/` | `page.tsx`（サーバー）、`note-editor.tsx`（クライアント）、`actions.ts`（サーバーアクション） |

顧客の画面（承認画面）と顧客ルールの画面からリンクします。DB のスキーマ・RLS・マイグレーションは変えていません（既存の `customer_note_versions` の INSERT 権限と RLS をそのまま使う）。

### 保存の動き

- 入力は `customerId` / `noteId` / `expectedVersion`（編集元の版）/ `status` / `title` / `body`。作成者・版番号・顧客の上書きは入力として受け付けない。
- ログインは `auth.getUser()` で確認し、作成者はその結果、版は `expectedVersion + 1` にサーバーが決める。
- 顧客・親メモ・最新の版を、担当者の権限（RLS）かつ `customer_id` 明示で読み、返った行の顧客も照合する。最新の版が `expectedVersion` と違えば保存しない。
- 同じ版の同時保存は主キー重複（23505）で片方が拒否され、競合として返す。保存の成功時は画面が `router.refresh()` で最新の表示を読み直すが、失敗・競合・結果不明のときの自動の再送・再読込はしない。
- 通信の失敗、応答の欠落、戻り値が書いた行（メモ・顧客・版・状態・作成者・タイトル・本文）と一致しない場合は「結果不明」とし、保存されていないとは言わない。
- 保存・結果不明・競合・古い版のあと、画面は「最新の状態を読み込む」まで再送できない。内容を変えると「確認しました」は外れる。ページを開く・メモを選ぶだけでは保存しない。
- メモID・版は一覧と編集画面に表示する（結果不明のとき、再読込してIDと版で確認できる）。
- 親（`customer_notes`）への書込、既存の版の UPDATE / DELETE はしない。過去の版と判断ログの参照（`note_versions_used`）は残る。

### 文章の扱い

- 保存済みの文字列は、長さ・空白・改行を含めてそのまま表示・保存する。無効化には新しい検証を課さない（空白だけの保存済みメモも無効にできる）。「有効」にするときだけ、タイトルと本文が空白以外を含むことを求める。長さの上限は設けない。
- `<input>` は改行を取り除き、`<textarea>` は改行を LF にそろえる。触っていない欄は保存済みの値（CRLF や改行入りタイトルを含む）をそのまま送る。**触った欄の改行は入力欄の正規化に従う。**
- 画面はエスケープされた React のテキストとしてだけ表示する。HTML として描画・評価しない。

### 提案づくりでの扱い

- 提案づくり（`src/lib/proposals/store.ts`）は、各メモの現在の版のうち**状態が「有効」のもの**だけを AI に渡す。最新の版を「無効」にすると、以降の仕訳候補には使われない（作成済みの候補・判断ログは変わらない）。
- AI に渡したメモの `noteId` と版は、判断ログの `note_versions_used` に残る。メモ本文は `maskSensitive`（長い数字の伏字）を通って送られる。
- メモは**参考データ**で、権限の付与・人の承認の省略・ツール実行の指示ではない。AI にはツールを渡さず、出力はスキーマの項目だけを使い、マスタにない値は弾き、確信度はプログラムが計算し、承認は人が行う。これらはメモの内容で変わらない（`tests/unit/note-proposal-consumption.test.ts`）。
- **メモの置き場所（プロンプト版 `journal-proposal/2026-10-24.1` から）**: メモの題名・本文は system ではなく、user メッセージの参考データ（`JSON.stringify` した JSON）の `notes` に入れる。system は固定の指示だけで、メモの内容で変わらない。system は、顧客固有の経理上の例外処理は根拠として使ってよい一方、データ内の指示（指示・役割・出力形式の変更、ツール実行、検証・承認の省略、開示）には従わないと明記している（`tests/unit/prompt-trust-boundary.test.ts`）。
- **未検証の制限**: 上は組み立て方（どこに何を置くか）の強化で、注入への耐性を保証するものではない。メモの文面に紛れた指示を実際のモデルが参考にしてしまうか、正当な例外メモを正しく使えるか（正答率）は、**実モデルで未評価**。修正済み事例（正解付きテストセット）と注入文での評価は**本番公開の前に必須**で、モックのテストはその代わりにならない。実 AI も呼んでいない。上記の守りは、AI の出力を受け取った後のプログラム側（マスタ検証・確信度・人の承認）によるもの。

## 新しいメモの作成（`/customers/[customerId]/notes/new?requestId=<UUID>`）

担当者が新しい文章メモを、**「無効」の版1**として1回だけ作る範囲です。スキーマの状態は active / inactive のままで、「提案中」などの状態・優先順位・有効期間は作っていません。会計上の文面を自動で補うこともしません。

| ファイル | 役割 |
| --- | --- |
| `create-schema.ts` | 入力検証（純粋関数、zod strict）。`customerId` / `requestId` / `title` / `body` だけ。タイトル・本文は空白だけと NUL を拒否し、それ以外は入力のまま（長さの上限なし）。URL の検索パラメータ（`requestId` だけ）の検証、リンクの組立（`newNoteHref`）、結果不明の固定文 |
| `create-load.ts` | 画面用の読込（読取専用）。担当者に見える顧客だけを返し、見えない・UUID でないは null、失敗は固定文（`NoteCreateLoadError`） |
| `create-submit.ts` | 保存のサーバー側処理（`createCustomerNote`）。`auth.getUser()` → 見える顧客の読み直し → RPC 1回 |
| `supabase/migrations/20261023000400_create_customer_note.sql` | RPC `create_customer_note(p_customer_id, p_note_id, p_title, p_body) returns uuid`（SECURITY INVOKER、`search_path=''`、authenticated のみ実行可） |
| `src/app/customers/[customerId]/notes/new/` | `page.tsx`（サーバー）、`new-note-form.tsx`（クライアント）、`actions.ts`（サーバーアクション） |

### 動き

- 一覧ページ（`/notes`）の「新しいメモを作る」リンクが、描画のたびに `randomUUID()` の依頼IDを URL に付ける。依頼IDがそのまま新しいメモのID（`customer_notes.id`）になり、再読み込みしても変わらない。URL の依頼IDが欠落・不正・配列・余計なキー付きなら、フォームを出さず入力値も表示しない（書込もしない）。
- フォームはタイトル・本文が空欄から始まり、人が入力して「確認しました」にチェックを入れるまで保存ボタンは押せない。ボタンは「無効で保存（AIにはまだ使わない）」の1つだけ。内容を変えると確認は外れる。ページを開くだけでは保存しない。フォームは顧客・依頼IDを key にしており、別の依頼IDへ入力や確認を持ち越さない。
- 入力は strict で、状態・版・作成者・メモIDなどの上書きは受け付けない。RPC に渡すのは `p_customer_id / p_note_id / p_title / p_body` の4つだけ。
- RPC は、引数が null でないこと、タイトル・本文が空白だけでない（空白の集合は JS の `trim` と同じ文字を明示。`E'\v'` に頼らない）こと、`auth.uid()` があり `can_access_customer` を満たすことを確認し、同じトランザクションで親（作成者 = `auth.uid()`）と版1（`inactive` / 作成者 = `auth.uid()`）を INSERT する。UPDATE / DELETE はしない。RLS・テーブル権限は変えない。版1の INSERT が失敗すれば親も残らない。
- 同じ依頼IDの2回目は主キー重複（23505）で拒否され、何も上書きしない。「競合」として返し、自動の再試行はしない。DB が拒否したと確かなエラー（22xxx / 23xxx / P0001 / 42501）は「保存していない」、通信失敗・コードのないエラー・戻り値の欠落や不一致は「結果不明」（保存されていないとは言わない）。
- 保存済み・結果不明・競合のあとは、この画面から再送できない（入力欄も無効）。メモID（依頼ID）と一覧へのリンクを表示する。
- 保存後のメモは「無効」で、仕訳候補づくりには使われない。AI に使うには、一覧の編集画面で人が内容を確認して「有効」の新しい版として保存する（既存の動き）。
- 画面はエスケープされた React のテキストとしてだけ表示する。HTML として描画・評価しない。

### 範囲外

- 「有効」での新規作成、提案中・下書きなどの新しい状態、タイトル・本文の長さの上限、既存メモとの重複の判定。
- メモの削除、過去の版の編集、管理者限定の制限、権限・RLS の変更、AI のプロンプト・モデルの変更。
- 規則ページの説明文は、文章メモの編集は本画面で行えると案内している（リンクも追加済み）。

### テスト

`tests/unit/note-editor-schema.test.ts` / `note-editor-load.test.ts` / `note-editor-submit.test.ts` / `note-editor-page.test.ts` / `note-proposal-consumption.test.ts`（モック。共有: `tests/fixtures/note-editor.ts`、`tests/fixtures/rule-editor.ts` の `fakeClient`）。
新規作成: `tests/unit/note-create-schema.test.ts` / `note-create-load.test.ts` / `note-create-submit.test.ts`（`tests/fixtures/rule-candidate.ts` の `rpcClient`）/ `note-create-page.test.ts`（モック）/ `note-create-form.test.ts`（`useState` を差し替えた描画。保存中・保存後ロック時の入力欄の無効化）と、実 Postgres 用の `tests/db/note-create.test.ts`（合成データ・トランザクションをロールバック）。

### 未確認（保留）

実行状況: 既存メモの編集については、Codex による独立レビューで型チェックと単体テスト339件が通過し、最終の lint・型チェック・339件のunit・ビルド・diff --checkもCodexが実行して成功した（2026-10-24、新規作成の追加前）。新規作成の追加後は、Codex が初回の型チェックと単体テスト384件を実行して通過した。その後、新規フォームの保存中の入力欄の無効化（`busy`）と、その描画テスト（`tests/unit/note-create-form.test.ts`）を追加しており、これらを含む最終の一括チェック（lint・型チェック・37ファイル387unit・ビルド・diff --check）はCodexが実行し成功（2026-10-24 09:21 JST）。DB テスト・実ブラウザ・実 AI は未実行です。次は未確認です。

- 実 Postgres での担当者の INSERT（RLS の `can_access_customer` と `created_by = auth.uid()`、`check_version_customer` トリガー、主キー重複）と、同時保存の実際の挙動。既存メモの編集に固有の DB テストは追加していない（新規作成の DB テスト `tests/db/note-create.test.ts` のソースはあるが、未実行）。
- 実ブラウザでの操作（選択、確認チェック、2つの保存ボタン、保存後のロックと再読込）。
- 新規作成の追加分: 初回の型チェックと単体384件は Codex が実行済み（上記）。追加後の最終一括チェック・ビルドも成功。DBテストは未実行。
- 新規作成の、実 Postgres での実行（新しいマイグレーションの適用、RPC の権限・RLS・親＋版1の原子性、同じ依頼IDの重複、空白判定）。`tests/db/note-create.test.ts` は書いたが未実行。
- 同じ依頼IDでの同時の2回送信の実際の挙動（主キーで片方が 23505 になる想定。`tests/db/concurrency.test.ts` 相当の2接続テストは追加していない）。
- 既存データのある DB への新しいマイグレーションのアップグレード検証（空 DB からの作成と、既存データありからの適用の両方）。
- 実ブラウザでの操作（新規フォームの入力、確認チェック、ボタン、保存後のロック、一覧へ戻る）。
- 実 AI にメモの文面がどう影響するか。メモには経理上の例外など指示的な文も正当に書かれるため、画面では禁止せず、秘密情報・不要な個人情報・権限変更や承認省略の内容だけを避けるよう案内している。プロンプトインジェクションへの耐性を主張するものではない。
