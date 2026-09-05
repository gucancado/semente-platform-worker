/**
 * src/meetings-summary/provider.ts
 *
 * Provider LLM do digest de reunião. Abstração fina sobre um chat completion
 * one-shot: recebe {system, user} (de prompt.ts) e devolve texto BRUTO + uso de
 * tokens + `finishReason`. Quem valida o texto é `parseDigest`; quem registra
 * custo é o service.
 *
 * Molde: src/whatsapp/ai-llm.ts. PURO no sentido de env — importa só `openai`;
 * a construção com apiKey/model real acontece na borda (index.ts / CLI).
 */
import OpenAI from 'openai';
import type { ReasoningEffort } from 'openai/resources/shared';
import { stripLoneSurrogates } from '../whatsapp/text-safety.js';

export type SummaryLlmUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Parte de `inputTokens` que veio de cache de prompt, quando a API informa.
   *  Cobrada bem mais barato — ignorá-la SUPERESTIMA o custo, que é o erro certo
   *  a cometer, mas registrar o número deixa a conta auditável. */
  cachedInputTokens: number;
};

export type SummaryLlmResult = {
  raw: string;
  usage: SummaryLlmUsage;
  /** 'stop' = terminou sozinho. 'length' = bateu no teto de saída, o JSON veio
   *  truncado e o job deve RETENTAR em vez de concluir vazio. */
  finishReason: string | null;
};

export interface SummaryLlm {
  /** Modelo em uso — vai pra coluna `model` de llm_metrics / episodes.summary_model. */
  readonly model: string;
  readonly provider: string;
  summarize(system: string, user: string): Promise<SummaryLlmResult>;
}

/**
 * US$ por 1M tokens. **Conferir no pricing vigente ao trocar de modelo** — esta
 * tabela é uma cópia local que envelhece sozinha, e já envelheceu uma vez: o
 * piloto registrou gpt-5.4-mini a 0,25/2,00 (preço de gpt-5-mini) e a revisão do
 * Codex apontou o valor correto, 3× maior. O efeito de errar aqui é silencioso —
 * `llm_metrics.cost_usd` fica menor que a fatura — por isso modelo fora da
 * tabela cai no fallback CARO em vez de 0.
 */
export const RATE_USD_PER_1M: Record<string, { input: number; output: number; cachedInput?: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cachedInput: 0.075 },
};
const FALLBACK_RATE = { input: 2.5, output: 10 };

/**
 * A família de raciocínio (gpt-5*, o3*, o4*) RECUSA `temperature` diferente de 1
 * (400 unsupported_value) e cobra tokens de raciocínio dentro de
 * `completion_tokens`. Modelo fora dessa família segue em temperature 0.
 */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o3|o4)/.test(model);
}

export function summaryCost(model: string, usage: SummaryLlmUsage): number {
  const rate = RATE_USD_PER_1M[model] ?? FALLBACK_RATE;
  const inTok = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  const outTok = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
  const cached = Number.isFinite(usage.cachedInputTokens) ? usage.cachedInputTokens : 0;
  // `prompt_tokens` da API JÁ INCLUI os cacheados; cobrar os dois cheios contaria
  // a parte cacheada duas vezes. Só desconta quando o preço de cache é conhecido.
  const cachedRate = (rate as { cachedInput?: number }).cachedInput;
  const fresh = cachedRate != null ? Math.max(0, inTok - cached) : inTok;
  const cachedCost = cachedRate != null ? (cached / 1_000_000) * cachedRate : 0;
  return (fresh / 1_000_000) * rate.input + cachedCost + (outTok / 1_000_000) * rate.output;
}

/** Teto de saída. Generoso de propósito: nos modelos de raciocínio ele cobre
 *  TAMBÉM os tokens de raciocínio, e um teto apertado devolve `finish_reason:
 *  'length'` com conteúdo vazio. O digest medido usa ~300; 2000 dá folga de 6×
 *  sem deixar uma resposta anômala correr solta. */
export const MAX_COMPLETION_TOKENS = 2000;

/** Timeout da requisição. Precisa ficar CONFORTAVELMENTE abaixo do lease do job
 *  (5min) — senão uma chamada pendurada deixa o job ser reivindicado de novo e
 *  duas execuções competem para gravar o mesmo digest. Medido: 1,7–4,1s. */
export const REQUEST_TIMEOUT_MS = 90_000;

export class OpenAISummaryLlm implements SummaryLlm {
  readonly model: string;
  readonly provider = 'openai';
  private client: OpenAI;
  private reasoningEffort: ReasoningEffort;

  constructor(opts: { apiKey: string; model: string; client?: OpenAI; reasoningEffort?: ReasoningEffort }) {
    this.client = opts.client ?? new OpenAI({ apiKey: opts.apiKey });
    this.model = opts.model;
    // 'none' é o default do gpt-5.4-mini e o certo aqui: extrair assunto de uma
    // transcrição não é problema de raciocínio, e cada token de raciocínio é
    // cobrado como saída. Medido no episódio 453 (63min, 13.669 tokens de
    // entrada): 'none' 231 tokens de saída / 8 pontos, 'low' 279 / 7 pontos —
    // mais barato, um ponto a mais, e os dois com conteúdo conferido contra a
    // transcrição. Não há ganho de qualidade que pague o raciocínio aqui.
    this.reasoningEffort = opts.reasoningEffort ?? 'none';
  }

  async summarize(system: string, user: string): Promise<SummaryLlmResult> {
    const reasoning = isReasoningModel(this.model);
    const r: any = await this.client.chat.completions.create(
      {
        model: this.model,
        ...(reasoning ? { reasoning_effort: this.reasoningEffort } : { temperature: 0 }),
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          // stripLoneSurrogates: surrogate órfão vindo do STT faz o parser JSON do
          // servidor recusar o body (400) e a reunião nunca é resumida. No-op em texto são.
          { role: 'system', content: stripLoneSurrogates(system) },
          { role: 'user', content: stripLoneSurrogates(user) },
        ],
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );
    const raw = typeof r?.choices?.[0]?.message?.content === 'string' ? r.choices[0].message.content : '';
    return {
      raw,
      finishReason: r?.choices?.[0]?.finish_reason ?? null,
      usage: {
        inputTokens: Number(r?.usage?.prompt_tokens ?? 0),
        // completion_tokens JÁ inclui os tokens de raciocínio nos modelos gpt-5*,
        // que são cobrados como saída — somar de novo contaria em dobro.
        outputTokens: Number(r?.usage?.completion_tokens ?? 0),
        cachedInputTokens: Number(r?.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      },
    };
  }
}
