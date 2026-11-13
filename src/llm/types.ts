/**
 * src/llm/types.ts
 *
 * Contrato ÚNICO de LLM de texto do worker. Toda tarefa de texto (IA do CRM
 * nível 1 e 2, digest de reunião, Lua) fala com um `TextLlm`; qual provedor
 * está atrás dele é decidido na BORDA por env (`*_PROVIDER` + `*_MODEL`), sem
 * deploy de código. Ver src/llm/factory.ts.
 *
 * FORA deste contrato, de propósito: transcrição de áudio (Whisper/gpt-4o-
 * transcribe), recuperação de reunião pela gravação, a sonda da conta OpenAI e
 * os embeddings da Lua. A Anthropic não transcreve áudio nem tem embeddings —
 * esses seguem na OPENAI_API_KEY.
 */

export type LlmProviderName = 'anthropic' | 'openai';
export const LLM_PROVIDERS: readonly LlmProviderName[] = ['anthropic', 'openai'];

export type LlmEffort = 'low' | 'medium' | 'high';

export type LlmMessage = { role: 'user' | 'assistant'; content: string };

export type LlmCompleteArgs = {
  system: string;
  messages: LlmMessage[];
  /**
   * Pede saída JSON. Na Anthropic vira structured output (`output_config.format`)
   * com o `schema` — nunca prefill (400 nos modelos atuais). Na OpenAI vira
   * `response_format: json_object` (o schema não é enviado; é o comportamento de
   * antes da camada, mantido idêntico). O validador de cada tarefa continua sendo
   * a defesa final nos DOIS casos.
   */
  json?: { schema: Record<string, unknown> };
  maxTokens: number;
  /** Profundidade de raciocínio. Anthropic: `output_config.effort`. OpenAI: só
   *  modelos de raciocínio (gpt-5*), via `reasoning_effort`; ver openai.ts. */
  effort?: LlmEffort;
  timeoutMs?: number;
};

/**
 * Uso normalizado entre provedores. `input` é o TOTAL de tokens de entrada
 * (frescos + lidos do cache + gravados no cache) — é a semântica do
 * `prompt_tokens` da OpenAI; na Anthropic `input_tokens` NÃO inclui os de cache
 * e o adapter soma. `cachedInput` e `cacheWrite` são PARTES de `input`.
 * `output` inclui tokens de raciocínio/thinking nos dois provedores (cobrados
 * como saída).
 */
export type LlmUsage = {
  input: number;
  output: number;
  cachedInput: number;
  cacheWrite: number;
};

/** 'stop' = terminou; 'length' = bateu no teto (JSON truncado → retentar);
 *  'refusal' = o classificador de segurança recusou (Anthropic). */
export type LlmFinishReason = 'stop' | 'length' | 'refusal' | 'other';

export type LlmCompleteResult = {
  text: string;
  usage: LlmUsage;
  model: string;
  provider: LlmProviderName;
  finishReason: LlmFinishReason | null;
};

export interface TextLlm {
  readonly provider: LlmProviderName;
  readonly model: string;
  complete(args: LlmCompleteArgs): Promise<LlmCompleteResult>;
}
