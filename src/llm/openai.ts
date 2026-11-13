/**
 * src/llm/openai.ts
 *
 * Adapter OpenAI do TextLlm (chat.completions). Reproduz EXATAMENTE o
 * comportamento dos providers de antes da camada, para que `*_PROVIDER=openai`
 * seja um rollback sem surpresa:
 *   - JSON = `response_format: json_object` (o schema não é enviado). A API
 *     exige a palavra "json" na conversa; se o prompt não a tiver, uma linha é
 *     anexada ao system.
 *   - família de raciocínio (gpt-5*, o3*, o4*): recusa `temperature` ≠ 1, recebe
 *     `reasoning_effort` (default 'none' — medido no digest: mais barato e sem
 *     perda) e usa `max_completion_tokens`. Demais modelos: temperature 0.
 */
import OpenAI from 'openai';
import type { ReasoningEffort } from 'openai/resources/shared';
import { stripLoneSurrogates } from '../whatsapp/text-safety.js';
import type { LlmCompleteArgs, LlmCompleteResult, LlmFinishReason, TextLlm } from './types.js';

export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o3|o4)/.test(model);
}

function mapFinish(r: string | null | undefined): LlmFinishReason | null {
  if (r == null) return null;
  if (r === 'stop') return 'stop';
  if (r === 'length') return 'length';
  return 'other';
}

export class OpenAITextLlm implements TextLlm {
  readonly provider = 'openai' as const;
  readonly model: string;
  private client: OpenAI;

  constructor(opts: { apiKey: string; model: string; client?: OpenAI }) {
    this.client = opts.client ?? new OpenAI({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async complete(args: LlmCompleteArgs): Promise<LlmCompleteResult> {
    const reasoning = isReasoningModel(this.model);
    let system = stripLoneSurrogates(args.system);
    if (args.json && !/json/i.test(system) && !args.messages.some((m) => /json/i.test(m.content))) {
      system += '\n\nResponda em JSON.';
    }
    const effort: ReasoningEffort = (args.effort as ReasoningEffort | undefined) ?? 'none';
    const r: any = await this.client.chat.completions.create(
      {
        model: this.model,
        ...(reasoning ? { reasoning_effort: effort } : { temperature: 0 }),
        max_completion_tokens: args.maxTokens,
        ...(args.json ? { response_format: { type: 'json_object' as const } } : {}),
        messages: [
          { role: 'system', content: system },
          ...args.messages.map((m) => ({ role: m.role, content: stripLoneSurrogates(m.content) })),
        ],
      },
      args.timeoutMs ? { timeout: args.timeoutMs } : undefined,
    );
    const choice = r?.choices?.[0];
    return {
      text: typeof choice?.message?.content === 'string' ? choice.message.content : '',
      model: this.model,
      provider: this.provider,
      finishReason: mapFinish(choice?.finish_reason),
      usage: {
        input: Number(r?.usage?.prompt_tokens ?? 0),
        // completion_tokens JÁ inclui raciocínio nos gpt-5*.
        output: Number(r?.usage?.completion_tokens ?? 0),
        cachedInput: Number(r?.usage?.prompt_tokens_details?.cached_tokens ?? 0),
        cacheWrite: 0,
      },
    };
  }
}
