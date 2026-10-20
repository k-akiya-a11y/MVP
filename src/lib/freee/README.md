# src/lib/freee

freee会計API・freee請求書API のクライアント（読取、トークン管理）。リフレッシュトークン更新はここに一か所にまとめ、ロックで同時更新を防ぎます。書込の呼出しは src/lib/execution からのみ行います。未実装。
