// Fabrica de LlmClient por etapa do pipeline da Lua (extracao / judge / recap).
//
// Espelha embedding-provider.ts: quando `ANTHROPIC_API_KEY` esta provisionado,
// devolve o cliente real (Anthropic) ja configurado com o modelo da etapa.
// Quando ausente (ainda nao provisionado), devolve um stub cujo `complete()`
// lanca um erro claro — callers degradam explicitamente em vez de dar 500
// opaco; o LLM da Lua nunca pode derrubar o startup por falta da chave.
//
// Cada etapa tem seu modelo configuravel (LUA_EXTRACTION_MODEL / _JUDGE_ /
// _RECAP_), default 'claude-sonnet-4-6' (spec §5.4 — julgamento medio).

import { config } from '../config.js';
import { makeAnthropicClient, type LlmClient } from './llm.js';

function client(model: string): LlmClient {
  const key = config.ANTHROPIC_API_KEY;
  if (!key) {
    // Degrada explicitamente: quem precisa do LLM lanca um erro claro.
    return {
      model: 'unconfigured',
      complete: async () => {
        throw new Error('ANTHROPIC_API_KEY ausente — LLM da Lua nao configurado');
      },
    };
  }
  return makeAnthropicClient(key, { model });
}

export function getExtractionClient(): LlmClient {
  return client(config.LUA_EXTRACTION_MODEL);
}

export function getJudgeClient(): LlmClient {
  return client(config.LUA_JUDGE_MODEL);
}

export function getRecapClient(): LlmClient {
  return client(config.LUA_RECAP_MODEL);
}
