// Fabrica de LlmClient por etapa do pipeline da Lua (extracao / judge / recap).
//
// Espelha embedding-provider.ts: devolve o cliente real do provedor de
// LUA_PROVIDER (anthropic | openai) ja configurado com o modelo da etapa.
// Quando a chave falta, devolve um stub cujo `complete()`
// lanca um erro claro — callers degradam explicitamente em vez de dar 500
// opaco; o LLM da Lua nunca pode derrubar o startup por falta da chave.
//
// Cada etapa tem seu modelo configuravel (LUA_EXTRACTION_MODEL / _JUDGE_ /
// _RECAP_), default 'claude-sonnet-5-5' (spec §5.4 — julgamento medio).

import { config } from '../config.js';
import { createTextLlm } from '../llm/factory.js';
import { makeTextLlmClient, type LlmClient } from './llm.js';

function client(model: string): LlmClient {
  try {
    return makeTextLlmClient(createTextLlm('lua', config.LUA_PROVIDER, model, config));
  } catch (err) {
    // Degrada explicitamente (chave ausente / modelo incompativel com o
    // provedor): quem precisa do LLM lanca um erro claro; o startup segue.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      model: 'unconfigured',
      complete: async () => {
        throw new Error(`LLM da Lua nao configurado: ${reason}`);
      },
    };
  }
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
