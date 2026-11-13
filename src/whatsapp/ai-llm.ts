/**
 * src/whatsapp/ai-llm.ts
 *
 * Provider LLM da IA do CRM (nível 1 diário e nível 2 semanal). Fina camada
 * sobre o TextLlm de src/llm/: recebe {system, user} (montados pelos prompts) e
 * devolve o texto BRUTO + uso de tokens. Quem valida o texto é o parser da
 * tarefa (parseJudgmentDecision / parsePatternDecision); quem registra custo é o
 * runner, via `judgmentCost`.
 *
 * O PROVEDOR é escolhido na borda (index.ts / CLIs) por env — CRM_AI_PROVIDER e
 * CRM_AI_PATTERN_PROVIDER — e cada instância carrega o schema da sua tarefa
 * (JUDGMENT_SCHEMA ou PATTERN_SCHEMA de src/llm/schemas.ts), usado como
 * structured output na Anthropic.
 */
import { llmCost } from '../llm/pricing.js';
import type { LlmEffort, TextLlm } from '../llm/types.js';

export interface JudgmentLlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Partes de `inputTokens` lidas/gravadas em cache (0 quando a API não informa). */
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

export interface JudgmentLlmResult {
  raw: string;
  usage: JudgmentLlmUsage;
}

export interface JudgmentLlm {
  /** Modelo em uso — vai pra coluna `model` de llm_metrics. */
  readonly model: string;
  /** Provedor — vai pra coluna `provider` de llm_metrics ('openai' | 'anthropic'). */
  readonly provider: string;
  judge(system: string, user: string): Promise<JudgmentLlmResult>;
}

/** Custo em USD de uma chamada (tabela única em src/llm/pricing.ts). */
export function judgmentCost(model: string, usage: JudgmentLlmUsage): number {
  return llmCost(model, {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cachedInput: usage.cachedInputTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
  });
}

/** Nível 1: saída curta (~150 tokens); o teto cobre thinking adaptativo. */
export const JUDGMENT_MAX_TOKENS = 4000;
/** Nível 2: até dezenas de sugestões + backfills. */
export const PATTERN_MAX_TOKENS = 16000;

export class TextJudgmentLlm implements JudgmentLlm {
  readonly model: string;
  readonly provider: string;

  constructor(
    private llm: TextLlm,
    private opts: { schema: Record<string, unknown>; maxTokens: number; effort?: LlmEffort; thinking?: 'adaptive' | 'off' },
  ) {
    this.model = llm.model;
    this.provider = llm.provider;
  }

  async judge(system: string, user: string): Promise<JudgmentLlmResult> {
    const r = await this.llm.complete({
      system,
      messages: [{ role: 'user', content: user }],
      json: { schema: this.opts.schema },
      maxTokens: this.opts.maxTokens,
      // OpenAI: só vale em modelo de raciocínio; gpt-4o-mini ignora (temperature 0).
      effort: this.llm.provider === 'anthropic' ? this.opts.effort : undefined,
      thinking: this.opts.thinking,
    });
    return {
      raw: r.text,
      usage: {
        inputTokens: r.usage.input,
        outputTokens: r.usage.output,
        cachedInputTokens: r.usage.cachedInput,
        cacheWriteTokens: r.usage.cacheWrite,
      },
    };
  }
}
