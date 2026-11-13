/**
 * src/meetings-summary/provider.ts
 *
 * Provider LLM do digest de reunião. Fina camada sobre o TextLlm de src/llm/:
 * recebe {system, user} (de prompt.ts) e devolve texto BRUTO + uso de tokens +
 * `finishReason`. Quem valida o texto é `parseDigest`; quem registra custo é o
 * service. O provedor é escolhido na borda por MEETING_SUMMARY_PROVIDER.
 */
import { llmCost } from '../llm/pricing.js';
import { DIGEST_SCHEMA } from '../llm/schemas.js';
import type { LlmEffort, TextLlm } from '../llm/types.js';

export { isReasoningModel } from '../llm/openai.js';

export type SummaryLlmUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Parte de `inputTokens` lida do cache de prompt. */
  cachedInputTokens: number;
  /** Parte de `inputTokens` gravada no cache (Anthropic). */
  cacheWriteTokens?: number;
};

export type SummaryLlmResult = {
  raw: string;
  usage: SummaryLlmUsage;
  /** 'stop' = terminou sozinho. 'length' = bateu no teto de saída, o JSON veio
   *  truncado e o job deve RETENTAR em vez de concluir vazio. 'refusal' =
   *  recusa do classificador da Anthropic (o parse falha e o job retenta). */
  finishReason: string | null;
};

export interface SummaryLlm {
  /** Modelo em uso — vai pra coluna `model` de llm_metrics / episodes.summary_model. */
  readonly model: string;
  readonly provider: string;
  summarize(system: string, user: string): Promise<SummaryLlmResult>;
}

/** Custo em US$ (tabela única em src/llm/pricing.ts; modelo desconhecido = fallback caro). */
export function summaryCost(model: string, usage: SummaryLlmUsage): number {
  return llmCost(model, {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cachedInput: usage.cachedInputTokens,
    cacheWrite: usage.cacheWriteTokens ?? 0,
  });
}

/** Teto de saída. Cobre também raciocínio/thinking, cobrado como saída; um teto
 *  apertado devolve 'length' com conteúdo vazio. O digest medido usa ~300. */
export const MAX_COMPLETION_TOKENS = 4000;

/** Timeout da requisição. Precisa ficar CONFORTAVELMENTE abaixo do lease do job
 *  (5min) — senão uma chamada pendurada deixa o job ser reivindicado de novo e
 *  duas execuções competem para gravar o mesmo digest. */
export const REQUEST_TIMEOUT_MS = 90_000;

export class TextSummaryLlm implements SummaryLlm {
  readonly model: string;
  readonly provider: string;

  /**
   * `effort`: Anthropic usa como `output_config.effort`; na OpenAI vira
   * `reasoning_effort` dos gpt-5* — ausente = 'none' (medido no episódio 453:
   * mais barato e um ponto a mais que 'low', conteúdo conferido).
   */
  constructor(private llm: TextLlm, private opts: { effort?: LlmEffort } = {}) {
    this.model = llm.model;
    this.provider = llm.provider;
  }

  async summarize(system: string, user: string): Promise<SummaryLlmResult> {
    const r = await this.llm.complete({
      system,
      messages: [{ role: 'user', content: user }],
      json: { schema: DIGEST_SCHEMA },
      maxTokens: MAX_COMPLETION_TOKENS,
      effort: this.llm.provider === 'anthropic' ? this.opts.effort : undefined,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return {
      raw: r.text,
      finishReason: r.finishReason,
      usage: {
        inputTokens: r.usage.input,
        outputTokens: r.usage.output,
        cachedInputTokens: r.usage.cachedInput,
        cacheWriteTokens: r.usage.cacheWrite,
      },
    };
  }
}
