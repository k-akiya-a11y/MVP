# src/lib/ai

Claude API の呼出し、プロンプト（版を固定）、出力 JSON のスキーマ検証。AI は提案を返すだけで、ここから外部書込を起動しません。
モデルとプロンプトの版は `version.ts`、回答形式は `schema.ts`、AI に送る前の伏字は `mask.ts`、マスタとの照合は `validate.ts`。
