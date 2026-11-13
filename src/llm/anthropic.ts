/**
 * src/llm/anthropic.ts
 *
 * Adapter Anthropic do TextLlm (SDK oficial @anthropic-ai/sdk, Messages API).
 *
 * - JSON = structured outputs (`output_config.format` com o schema da tarefa),
 *   nunca prefill (400 nos modelos atuais) nem tool forçado (`tool_choice`
 *   tool/any dá 400 no Sonnet 5.5 / Opus 5.5). O schema passa por
 *   `toStructuredSchema`, que remove o que a API não aceita.
 * - Sem `temperature` (os modelos 5.x recusam valor não-default). Thinking
 *   fica no adaptativo do modelo, controlado por `effort`, salvo
 *   `thinking: 'off'` (ver `thinkingOff`: `disabled` dá 400 no Opus 5.5 em
 *   qualquer effort e no Sonnet 5.5, que usa `between_tools`).
 * - `system` com cache breakpoint: abaixo do mínimo cacheável a API ignora.
 * - stop_reason `refusal` (classificador de segurança) vira finishReason
 *   'refusal'; o texto pode não casar com o schema e o validador da tarefa trata
 *   como parse_error (retenta).
 */
import Anthropic from '@anthropic-ai/sdk';
import { stripLoneSurrogates } from '../whatsapp/text-safety.js';
import type { LlmCompleteArgs, LlmCompleteResult, LlmFinishReason, TextLlm } from './types.js';

const DROP_KEYS = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
]);

/**
 * Adapta um JSON Schema às limitações de structured outputs: todo objeto ganha
 * `additionalProperties: false`; restrições numéricas/de string/de array somem
 * (`minItems` só fica se for 0 ou 1). As restrições removidas continuam
 * valendo no validador da tarefa, que é a defesa final.
 */
export function toStructuredSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStructuredSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === 'minItems' && typeof v === 'number' && v > 1) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toStructuredSchema(pv)]));
      continue;
    }
    out[k] = toStructuredSchema(v);
  }
  const isObject = out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object'));
  if (isObject) out.additionalProperties = false;
  return out;
}

/** Forma de desligar o thinking por modelo; null = o modelo não permite. */
export function thinkingOff(model: string): Record<string, unknown> | null {
  if (model.startsWith('claude-opus-5-5')) return null; // 400 em qualquer effort
  if (model.startsWith('claude-sonnet-5-5')) return { type: 'between_tools' };
  return { type: 'disabled' };
}

function mapStop(r: string | null | undefined): LlmFinishReason | null {
  if (r == null) return null;
  if (r === 'end_turn' || r === 'stop_sequence') return 'stop';
  if (r === 'max_tokens') return 'length';
  if (r === 'refusal') return 'refusal';
  return 'other';
}

export class AnthropicTextLlm implements TextLlm {
  readonly provider = 'anthropic' as const;
  readonly model: string;
  private client: Anthropic;

  constructor(opts: { apiKey: string; model: string; client?: Anthropic }) {
    // maxRetries 2 (default do SDK): 429/5xx/529 são retentados dentro da
    // chamada; o que sobrar sobe para a fila, que classifica (errors.ts).
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async complete(args: LlmCompleteArgs): Promise<LlmCompleteResult> {
    const outputConfig: Anthropic.OutputConfig = {};
    if (args.effort) outputConfig.effort = args.effort;
    if (args.json) {
      outputConfig.format = { type: 'json_schema', schema: toStructuredSchema(args.json.schema) as Record<string, unknown> };
    }
    const off = args.thinking === 'off' ? thinkingOff(this.model) : null;
    const res = await this.client.messages.create(
      {
        model: this.model,
        ...(off ? { thinking: off as unknown as Anthropic.ThinkingConfigParam } : {}),
        max_tokens: args.maxTokens,
        system: [{ type: 'text', text: stripLoneSurrogates(args.system), cache_control: { type: 'ephemeral' } }],
        messages: args.messages.map((m) => ({ role: m.role, content: stripLoneSurrogates(m.content) })),
        ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      },
      args.timeoutMs ? { timeout: args.timeoutMs } : undefined,
    );
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const u = res.usage;
    const cacheRead = Number(u.cache_read_input_tokens ?? 0);
    const cacheWrite = Number(u.cache_creation_input_tokens ?? 0);
    return {
      text,
      model: this.model,
      provider: this.provider,
      finishReason: mapStop(res.stop_reason),
      usage: {
        // input_tokens da Anthropic EXCLUI os de cache; a camada usa o total.
        input: Number(u.input_tokens ?? 0) + cacheRead + cacheWrite,
        output: Number(u.output_tokens ?? 0),
        cachedInput: cacheRead,
        cacheWrite,
      },
    };
  }
}
