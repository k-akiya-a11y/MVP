# 段階12 の結果（YYYY-MM-DD）

[docs/integration-check.md 段階12](../integration-check.md#段階12-pr-4-の版での再確認手元の-pcclaude-api-は呼ばない) の記録です。このファイルをコピーして `<日付>-stage12.md` にします。秘密の値（キー・トークン・メールアドレス以外の個人情報）は書きません。

## 条件

| 項目 | 値 |
| --- | --- |
| 日時（UTC） | |
| コード（コミット SHA） | |
| 未コミットの差分 | なし／あり（`git diff` のハッシュ: ） |
| 実行場所 | 手元の PC（`npm run build` → `npm start`、http://localhost:3000） |
| Supabase | 検証用プロジェクト（Reference ID の先頭4文字: ）。新規／使い回し（使い回しなら `stage12-reconcile.sql` の since: ） |
| 候補生成 | 偽のモデル（`mock/`）。Claude API は呼んでいない |
| `check-env.mjs` | OK／NG |
| 操作した人 | 管理者: ／担当者（テスト用アカウント）: |

## 通し操作（12-2）

| # | 結果 | 観察したこと |
| --- | --- | --- |
| 1 | 成功／失敗／未確認 | |
| 2 | | |
| 3 | | `verify:mock-propose` の出力（processed・byConfidence・failures）: |
| 4 | | |
| 5 | | |
| 6 | | |
| 7 | | |
| 8 | | FAIL の件数: 、SKIP の件数と理由: |
| 9 | | ok = false の項目: |
| 10 | | |

## 権限確認スクリプトの結果

`copy(JSON.stringify(window.__permissionCheck, null, 2))` の出力を貼る（トークン・キーは含まれない）。

## 未確認・既知の問題

- 本物のモデルでの精度・費用・速度: 保留中（費用の判断待ち）
-

## 判定

- この記録は段階12の確認結果であり、検証完了・リリース承認ではない。
