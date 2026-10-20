import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { aiJournalOutputSchema, type AiJournalOutput } from "./schema";
import { JOURNAL_MODEL, JOURNAL_MODEL_PRICE_MICROS_PER_MTOK, JOURNAL_PROMPT_VERSION } from "./version";
import type { buildJournalPrompt } from "./prompt";

export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdMicros: number;
};

export type AiCallResult =
  | { status: "ok"; output: AiJournalOutput; model: string; promptVersion: string; usage: AiUsage }
  | {
      /** refused: 安全上の理由で断られた / invalid: 形式に合わない回答 / truncated: 上限で途切れた */
      status: "refused" | "invalid" | "truncated";
      model: string;
      promptVersion: string;
      usage: AiUsage;
      detail: string;
    };

/** 仕訳案を作る AI。テストではモックに差し替える */
export type JournalAi = (prompt: ReturnType<typeof buildJournalPrompt>) => Promise<AiCallResult>;

/** 費用（100万分の1ドル単位）。浮動小数点を使わず整数で計算し、端数は切り上げる */
export function costUsdMicros(u: Omit<AiUsage, "costUsdMicros">): number {
  const p = JOURNAL_MODEL_PRICE_MICROS_PER_MTOK;
  const total =
    u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite;
  return Math.ceil(total / 1_000_000);
}

/**
 * Claude API で仕訳案を1件作る。ツールは渡さない（AI は JSON の提案を返すだけ）。
 * モデルは版を固定しているので、別モデルへの自動切替（fallbacks）は使わない。断られたら担当者に回す。
 */
export function claudeJournalAi(client: Anthropic = new Anthropic()): JournalAi {
  return async (prompt) => {
    const response = await client.messages.create({
      model: JOURNAL_MODEL,
      max_tokens: 8000,
      // 定型的な判断なので思考は浅く（費用と待ち時間を抑える）
      output_config: { effort: "low", format: zodOutputFormat(aiJournalOutputSchema) },
      system: prompt.system,
      messages: prompt.messages,
    });
    const usageBase = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    const common = {
      model: response.model,
      promptVersion: JOURNAL_PROMPT_VERSION,
      usage: { ...usageBase, costUsdMicros: costUsdMicros(usageBase) },
    };
    if (response.stop_reason === "refusal") {
      return { status: "refused", ...common, detail: response.stop_details?.category ?? "refusal" };
    }
    if (response.stop_reason === "max_tokens") {
      return { status: "truncated", ...common, detail: "max_tokens" };
    }
    // 回答の JSON は自前で検証する（使用量を判断ログに残すため、parse の例外に頼らない）
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: "invalid", ...common, detail: "JSON として読めません" };
    }
    const parsed = aiJournalOutputSchema.safeParse(json);
    if (!parsed.success) {
      return { status: "invalid", ...common, detail: parsed.error.message };
    }
    return { status: "ok", ...common, output: parsed.data };
  };
}
