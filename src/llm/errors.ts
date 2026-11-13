/**
 * src/llm/errors.ts
 *
 * Classificação de erro de LLM dos DOIS SDKs (openai, @anthropic-ai/sdk) nas
 * classes que as filas já usam:
 *   - `systemic` = ambiente (conta, crédito, auth, rate limit, 5xx, rede). NÃO
 *     consome tentativa: o mesmo item funciona quando a conta volta.
 *   - `item` = o pedido é o problema (4xx de conteúdo). Consome tentativa.
 *
 * Classificação pelo erro ESTRUTURADO (`status` / `type` da resposta), nunca por
 * substring da mensagem — mensagem de LLM carrega contagem de tokens e um
 * `400 ... maximum context length is 500000 tokens` casaria com '500'. A única
 * exceção é uma frase INTEIRA e específica (crédito esgotado na Anthropic, ver
 * abaixo), nunca um número solto.
 *
 * Crédito esgotado:
 *   - OpenAI: 429 `insufficient_quota` → 429 → systemic.
 *   - Anthropic: 402 `billing_error` → systemic. Contas/versões antigas
 *     respondem 400 `invalid_request_error` com "Your credit balance is too low
 *     to access the Anthropic API" — sem tratar, isso viraria `item` e queimaria
 *     as tentativas de toda a fila, a mesma classe do incidente de 1.002 áudios
 *     com a OpenAI. Por isso o 400 com essa frase também é systemic.
 *
 * Desconhecido cai em `item` DE PROPÓSITO (falha fechada): sistêmico deixaria um
 * job defeituoso girando na fila para sempre.
 */
import {
  APIError as OpenAIAPIError,
  APIConnectionError as OpenAIConnectionError,
  APIUserAbortError as OpenAIUserAbortError,
} from 'openai';
import {
  APIError as AnthropicAPIError,
  APIConnectionError as AnthropicConnectionError,
  APIUserAbortError as AnthropicUserAbortError,
} from '@anthropic-ai/sdk';

export type LlmErrorClass = 'systemic' | 'item';

function systemicByStatus(status: number | undefined): boolean {
  if (status == null) return false;
  if (status >= 500) return true; // inclui 529 overloaded da Anthropic
  return status === 401 || status === 402 || status === 403 || status === 408 || status === 409 || status === 429;
}

const CREDIT_PHRASE = /credit balance is too low/i;

export function classifyLlmError(err: unknown): LlmErrorClass {
  // ── OpenAI ──
  if (err instanceof OpenAIConnectionError || err instanceof OpenAIUserAbortError) return 'systemic';
  if (err instanceof OpenAIAPIError) return systemicByStatus(err.status) ? 'systemic' : 'item';
  // ── Anthropic ──
  if (err instanceof AnthropicConnectionError || err instanceof AnthropicUserAbortError) return 'systemic';
  if (err instanceof AnthropicAPIError) {
    if (err.type === 'billing_error' || err.type === 'overloaded_error' || err.type === 'rate_limit_error') return 'systemic';
    if (err.type === 'authentication_error' || err.type === 'permission_error') return 'systemic';
    if (err.status === 400 && CREDIT_PHRASE.test(err.message)) return 'systemic';
    return systemicByStatus(err.status) ? 'systemic' : 'item';
  }
  return 'item';
}
