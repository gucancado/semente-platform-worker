/**
 * src/whatsapp/ai-llm.ts
 *
 * Provider LLM do julgamento IA nível 1 (spec v3 §7). Abstração fina sobre um chat
 * completion "one-shot": recebe {system, user} (montados por ai-judgment-prompt.ts,
 * D3) e devolve o texto BRUTO + uso de tokens. Quem valida o texto é
 * `parseJudgmentDecision` (D3); quem calcula/registra custo é o runner (D5) via
 * `judgmentCost`. Molde do provider da transcrição (src/transcription/provider.ts):
 * interface + impl OpenAI injetável (client opcional pra teste), custo por tabela de
 * preço local.
 *
 * PURO no sentido de env: importa só `openai` (sem config.js) — a construção com
 * apiKey/model real acontece na borda (index.ts / CLI), o runner recebe o provider
 * já pronto e injetável.
 */
import OpenAI from 'openai';

export interface JudgmentLlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface JudgmentLlmResult {
  raw: string;
  usage: JudgmentLlmUsage;
}

export interface JudgmentLlm {
  /** Modelo em uso — vai pra coluna `model` de llm_metrics. */
  readonly model: string;
  /** Provedor — vai pra coluna `provider` de llm_metrics ('openai'). */
  readonly provider: string;
  judge(system: string, user: string): Promise<JudgmentLlmResult>;
}

/**
 * US$ por 1M tokens (input/output) por modelo. Confirmar no pricing vigente ao trocar
 * de modelo. Modelos fora da tabela caem no fallback (o mais caro conhecido) — melhor
 * superestimar custo do que registrar 0 silenciosamente.
 */
export const RATE_USD_PER_1M: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
};

const FALLBACK_RATE = { input: 2.5, output: 10 };

/** Custo em USD de uma chamada, a partir do modelo + uso de tokens. */
export function judgmentCost(model: string, usage: JudgmentLlmUsage): number {
  const rate = RATE_USD_PER_1M[model] ?? FALLBACK_RATE;
  const inTok = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  const outTok = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
  return (inTok / 1_000_000) * rate.input + (outTok / 1_000_000) * rate.output;
}

export class OpenAIJudgmentLlm implements JudgmentLlm {
  readonly model: string;
  readonly provider = 'openai';
  private client: OpenAI;

  constructor(opts: { apiKey: string; model: string; client?: OpenAI }) {
    this.client = opts.client ?? new OpenAI({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async judge(system: string, user: string): Promise<JudgmentLlmResult> {
    // temperature 0: decisão determinística/conservadora (spec §7). response_format
    // json_object força o modelo a devolver só JSON — o validador (D3) ainda é a defesa,
    // mas isso reduz o descarte por cercas de código.
    const r: any = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const raw = typeof r?.choices?.[0]?.message?.content === 'string' ? r.choices[0].message.content : '';
    return {
      raw,
      usage: {
        inputTokens: Number(r?.usage?.prompt_tokens ?? 0),
        outputTokens: Number(r?.usage?.completion_tokens ?? 0),
      },
    };
  }
}
