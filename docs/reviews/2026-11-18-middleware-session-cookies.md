# 未認証の転送・API 401 で、セッション Cookie の削除・更新が捨てられる疑い: 実装前の期待記録

作成: 2026-11-18（コード修正前の期待の記録。実装後にこの節を書き換えない。誤りがあれば末尾に日時と理由を追記する）。製品コード（`src/middleware.ts`）は未変更。Claude はコマンド・DB・外部 API を実行していない。

## 目的

`src/middleware.ts:17-21` の `setAll` は、Supabase SSR の `getUser` が返した Cookie（期限切れの削除や、トークン更新）を、そのとき作った `response`（`NextResponse.next`）にだけ載せる。一方、未認証のときは `middleware.ts:28`（API の 401）と `middleware.ts:33`（`/login` への転送）で**新しい応答**を作って返すため、`response` が捨てられ、Cookie が届かない疑いがある。結果として、ブラウザに期限切れの Cookie が残り続ける（削除指示が届かない）可能性がある。これは疑いであり、実行で確認していない。

## 期待する動作（修正後）

1. `getUser` の中で `setAll` が返した Cookie（名前・値・`Max-Age`・`Path`・`HttpOnly`・`Secure`・`SameSite`）は、認証成功の `next` 応答だけでなく、未認証ページの `/login` への転送と、API の 401 にも、そのまま載る。
2. 転送先は固定の `/login` で、元のクエリは除去する（従来どおり）。API 401 の本文は `{ error: "ログインしてください" }` のまま。
3. Cookie の更新がなければ、どの経路にも `Set-Cookie` を付けない。
4. 変えない: 認証・顧客・管理者の権限判定、公開パス（`/login`、`/auth/callback`、`/api/cron/`）の規則、環境変数がない場合の素通り。

## 例（架空データ）

| 状況 | 現状（予測） | 期待 |
| --- | --- | --- |
| 未認証で `/customers/c1?secret=x`、`setAll` が削除 Cookie（`Max-Age=0`、`Path=/`、`HttpOnly`、`Secure`、`SameSite=lax`）と更新 Cookie を返す | 307 で `/login`（クエリなし）。**Cookie なし** | 同じ転送で、両方の Cookie が属性つきで残る |
| 未認証で `/api/customers/c1/statements`、同上 | 401。**Cookie なし** | 401 と固定本文で、両方の Cookie が残る |
| 認証済みで更新 Cookie 1つ | next で通り、Cookie が載る | 変わらない |
| Cookie の更新なし | Set-Cookie なし | 変わらない |

## 変更しない範囲

- `src/middleware.ts` の権限判定・公開パス・matcher、顧客・管理者の権限、Supabase の設定、DB、UI、依存関係、保留中の文書、無関係な既存の変更。

## 実装方針（最小・今回は実装しない）

未認証の2つの応答に、`response.cookies.getAll()` の Cookie（名前・値・属性）を写す小さな補助関数を足す想定。方式は Codex の確認後に決める。

## テスト（今回追加。製品コードは未変更）

`tests/unit/middleware-session.test.ts`。実物の `NextRequest` / `NextResponse` を使い、モックは `@supabase/ssr` の `createServerClient` だけ。Cookie はすべて合成。環境変数は `vi.stubEnv`、モックは `afterEach` で後始末する。

- 未認証ページの転送: 307、`/login`（クエリなし）、削除・更新 Cookie の属性が残る。
- 未認証 API: 401、固定 JSON、同上。
- 認証済み next: 更新 Cookie が載る。
- Cookie の更新なし: 転送・401・next・公開パスのいずれも `Set-Cookie` なし。

## 実行状況と予測（実行結果ではない）

- **テストは未実行。** Claude は実行していない。
- 予測: 1 件目（転送）と 2 件目（API 401）は、現状のコードでは失敗する見込み。3 件目と 4 件目は成功する見込み。この予測が外れた場合は、元の記載を残して追記する。
- 型検査・lint・全体のユニットテストも未実行。

## この記録が主張しないこと

- 疑いの確認、修正、リリース可否。実ブラウザ・実 Supabase・実 OAuth での挙動。Next.js の `NextResponse` の Cookie 直列化の細部は、実行して確かめるまで未確認。

## 次の手順

製品コードは変更せず、Codex にテストの赤の確認とレビューを依頼する。

---

## 追記 2026-11-18: 再現結果・実装根拠・未実行事項（上の記録は変更していない）

### 再現結果（Codex の報告。Claude は実行していない）

Codex が回帰テストを実行し、4 件中 2 件が失敗、2 件が成功（ツールセッション 30595、exit 1）。失敗は未認証ページの転送と API 401 の 2 件で、削除 Cookie が `undefined`。認証済み next と更新なしは成功。上の予測どおり。

### 実装（最小修正）

- `src/middleware.ts` に補助関数 `copyCookies(from, to)` を追加。`from.cookies.getAll()` の各 Cookie（名前・値・属性を持つ `ResponseCookie`）を `to.cookies.set(cookie)` で新しい応答へ写す。
- 呼び出しは 2 か所: API 401 の `NextResponse.json(...)` と、`/login` への `NextResponse.redirect(login)`。いずれも `response`（`setAll` が更新した最新の応答）から写す。
- 根拠: `setAll`（`src/middleware.ts` の `cookies.setAll`）は Cookie を `response` にだけ載せ、未認証の 2 経路は別の応答を返していたため捨てられていた。`getAll()` は `set` が保持した属性（`Max-Age`、`Path`、`HttpOnly`、`Secure`、`SameSite`）を返すので、そのまま渡せば属性も残る。
- Cookie だけを写し、ヘッダーは写さない。そのため `x-middleware-next` などの内部ヘッダーは redirect / json に入らない。
- 変更なし: 権限判定、公開パス、matcher、環境変数の扱い、ステータス（307 / 401）、本文、転送先（クエリなしの `/login`）。

### テストの追加

`tests/unit/middleware-session.test.ts` の転送・API 401 の既存テストに、最終 `Set-Cookie` ヘッダーが 2 件の個別 Cookie で、削除側に `Max-Age=0`、更新側に `Max-Age=3600` があることの検証を追加。

### 未実行事項

- 修正後のテスト、型検査、lint、全体のユニットテストは未実行。成功の主張は、Codex の実行結果を待つ。
- `to.cookies.set(cookie)` が `ResponseCookie` の全属性を `Set-Cookie` に直列化する点、追加した `Set-Cookie` の検証が通る点は、実行で未確認。
- 実ブラウザ・実 Supabase・実 OAuth での挙動は未確認。

---

## 追記 2026-11-18: SetAllCookies 第二引数（キャッシュ禁止ヘッダー）のテスト追加と実行前の期待（上の記録は変更していない）

作成時点で、下のテストは未実行。Claude はコマンド・API・DB を実行していない。`src/middleware.ts` は今回も未変更。

### 疑いと契約の根拠

上の追記の `copyCookies` は Cookie だけを写し、ヘッダーは写さない。一方、`src/middleware.ts` の `setAll: (list) => { ... }` は第二引数 `headers` を受け取らない。Supabase SSR の契約では、この第二引数に、認証 Cookie を書く応答へ付けるべきヘッダーが入る。

- インストール済みの `node_modules/@supabase/ssr/dist/module/types.d.ts`（`SetAllCookies`）: 認証 Cookie を載せる応答は CDN・リバースプロキシにキャッシュされてはならず（他ユーザーにセッションが配信されうる）、ヘッダーは応答へ付ける。ライブラリが渡すのは `Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0`、`Expires: 0`、`Pragma: no-cache`。サーバークライアントでは**最初の Cookie 書き込みにだけ**付き、同じクライアントの以降の呼び出しでは `{}`。
- 同 `node_modules/@supabase/ssr/dist/module/cookies.js`: `applyServerStorage` の `setAll([...], { "Cache-Control": ..., Expires: "0", Pragma: "no-cache" })` が 3 ヘッダーの出どころ。サーバー用の `setAll` ラッパー（`hasSentHeaders`）が、最初の 1 回だけ headers を渡し、2 回目以降は `{}` にする。

疑い（未確認）は 2 点。(1) 第二引数が無視され、next・転送・API 401 のどれにもキャッシュ禁止ヘッダーが付かない。(2) 2 回目の `setAll` が `response = NextResponse.next(...)` で応答を作り直すため、1 回目の Cookie（と、付けていればヘッダー）が消える。

### 追加したテスト（`tests/unit/middleware-session.test.ts` のみ。既存の 4 件は維持）

モックの `setAll` は第二引数を渡すようにし、`state.calls` に指定があれば、その順に複数回呼ぶ（指定なしは従来どおり 1 回、headers は `{}`）。新しい `describe` に 7 件。

- next / redirect / API 401 の各経路（3 経路 × 2）
  - setAll 1 回（削除・更新 Cookie と 3 ヘッダー）で、Cookie の属性と 3 ヘッダーが残る。
  - setAll 2 回（1 回目は削除 Cookie と 3 ヘッダー、2 回目は更新 Cookie と `{}`）で、最初の Cookie と 3 ヘッダーが消えず、2 回目の Cookie も残る。最終 `Set-Cookie` は 2 件。ステータス・転送先（クエリなしの `/login`）・`x-middleware-next` も確認する。
- headers が `{}` のときは、キャッシュ禁止ヘッダーを足さない（保持側の過剰な付与の防止）。

### 実行前の期待（実行結果ではない）

現状の `src/middleware.ts` に対して、次を予測する。外れた場合は、この節を書き換えず、日時と理由を追記する。

- 失敗の見込み 6 件: 3 経路 × 2（setAll 1 回・2 回）。1 回の 3 経路は 3 ヘッダーが無い。2 回の 3 経路は 3 ヘッダーに加え、1 回目の削除 Cookie も消える見込み（next も同様。応答を作り直すため）。
- 成功の見込み 1 件: headers が `{}` のときにヘッダーを足さない確認（現状は何も足さない）。
- 既存の 4 件（転送・API 401・next の Cookie、更新なし）は成功の見込み。モックの変更は 1 回呼び出しの挙動を変えない。
- 型検査・lint・全体のユニットテストは未実行。

### 次の手順

製品コードは追加修正しない。Codex にこのテストの赤の確認（上の 6 件が失敗し、1 件と既存 4 件が成功するか）を依頼し、その結果を待つ。修正方針（`setAll` の第二引数の受け取りと、応答を作り直さない構成）は、結果を見てから決める。

### この追記が主張しないこと

疑いの確認、修正、リリース可否。実ブラウザ・実 CDN・実 Supabase での挙動。契約の根拠は、インストール済みパッケージの型定義とソースの記載であり、実行で確かめていない。

---

## 追記 2026-11-18: 赤の結果・修正と変更理由・限界（上の記録は変更していない）

### 赤の結果（Codex の報告。Claude は実行していない）

Codex が追加 11 テストを実行し、6 件失敗・5 件成功。単回 `setAll` では `cache-control` などが欠落し、複数回では最初の Cookie が消えた。実行前の期待（失敗 6 件）と一致する。

### 修正（`src/middleware.ts` のみ）

- 変更理由: 2 回目以降の `setAll` が `response` を作り直して最初の Cookie を捨てていたこと、第二引数 `headers` を受け取っていなかったことが原因。
- `setAll(list, headers)` は応答を作らず、Cookie を名前ごとの `Map`（同名は最後が勝ち）に、ヘッダーを `cache-control` / `expires` / `pragma` の 3 つだけ（名前は小文字化して大小文字を区別しない）に蓄積する。`request.cookies` の更新は従来どおり行う。
- 蓄積分を、next（最後に 1 回だけ作る）・redirect・401 の各応答へ `applyPending` で付ける。補助関数 `copyCookies` は廃止。
- 内部の `x-middleware-next` や、3 つ以外の任意ヘッダーは redirect / 401（および next）へ写さない。
- Cookie 名は HTTP 規則どおり大小文字を区別する（大小違いは別 Cookie）。
- 変更なし: 認可判定、公開パス、matcher、環境変数不足時の素通り（応答は従来どおり `NextResponse.next`）。

### テストの追加（`tests/unit/middleware-session.test.ts`）

- ヘッダー名の大小文字と、任意ヘッダー・`x-middleware-next` を写さないこと。
- `x-middleware-next` が redirect / 401 に出ず、next にだけ付くこと。
- 同名 Cookie は最後が勝ち、大小違いは別 Cookie、`Set-Cookie` は全経路で 2 件。
- `request.cookies` が最後の値に更新されること。

### 限界・未実行

- 修正後のテスト、型検査、lint は未実行（実行は Codex）。成功の主張は結果を待つ。`Parameters<NextResponse["cookies"]["set"]>[2]` の型が通るかは型検査で未確認。
- 同名 Cookie を名前だけで判定するため、`Path` / `Domain` が異なる同名 Cookie は区別しない（Supabase は同一属性で書くため想定外）。
- 実ブラウザ・実 CDN・実 Supabase での挙動は未確認。

---

## 追記 2026-11-18: Codex 最終検証（上の記録・期待・中間結果は変更していない。時系列を保持）

以下は Codex の報告に基づく記録。この追記の作成時に Claude はコマンドを実行していない。

### Codex の独立レビュー

- Cookie をリクエスト単位で蓄積していること、同名 Cookie は後勝ちであること、キャッシュ関連の 3 ヘッダー（`cache-control` / `expires` / `pragma`）だけを大小文字を区別せず保持することを確認した。
- 認可判定と公開パスの規則は変わっていないことを確認した。

### 実行済み結果（Codex）

| 項目 | コマンド | 結果 |
| --- | --- | --- |
| ユニットテスト | `node node_modules/vitest/vitest.mjs run --project unit --pool threads` | 75 ファイル 1803 件成功、exit 0、38.12 秒（今回の 15 件を含む） |
| 型検査 | `node node_modules/typescript/bin/tsc --noEmit --incremental false` | exit 0 |
| lint | `node node_modules/eslint/bin/eslint.js .` | exit 0 |
| 差分検査 | `git diff --check` | exit 0（既存の LF/CRLF 警告あり） |

### リポジトリの状態

- ブランチ: `fix/csv-integrity-and-proposal-hold`。HEAD: `0763fdf0ae75fc7ae71387c91bf4dd28a35250d7`。
- 未コミットは 139 項目（開始時 136 から、今回 3 件追加: middleware の変更、テストの新規、この記録の新規）。
- 保留文書 `docs/reviews/2026-11-06-proposal-budget-after-claim.md` の SHA256 は `3142146EC1895AF7400257E3013815B9A3AD06D253A3A044A2A291DFCED3CB26` で、変更なし。

### 環境・範囲・限界

- Docker engine のパイプが存在せず停止中。今回、Docker の起動や新環境の作成はしていない。停止コンテナ・volume の一覧は確認できない。
- 今回の検証範囲は、実物の `NextRequest` / `NextResponse` を使い、SSR 認証だけをモックしたもの。実ブラウザ、実 CDN、Google OAuth、実 Supabase、実 AI の検証はしていない。
- 本番 build は今回未実行。
- 実 DB、追加費用、バックアップ、push による公開は行っていない。
- 検証および Claude の修正プロセスは既に終了している。元から存在する無関係な Claude のツリーには触れていない。

### 次の手順

この最終追記の後に、Codex が確認する予定。
