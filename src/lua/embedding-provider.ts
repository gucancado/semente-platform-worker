// Fabrica do EmbeddingClient para o caminho de request-time (busca).
//
// Quando `OPENAI_API_KEY` esta provisionado, devolve o cliente real. Quando
// ausente (ainda nao provisionado), devolve um cliente cujo `embed()` lanca —
// `searchMemoria` captura essa falha e degrada para `lexical_only` (spec §8.2):
// a busca NUNCA pode morrer por falta da chave da OpenAI.

import { config } from '../config.js';
import { makeOpenAIEmbeddingClient, type EmbeddingClient } from './embeddings.js';

export function getEmbeddingClient(): EmbeddingClient {
  if (!config.OPENAI_API_KEY) {
    return {
      model: 'unconfigured',
      embed: async () => {
        throw new Error('OPENAI_API_KEY ausente');
      },
    };
  }
  return makeOpenAIEmbeddingClient(config.OPENAI_API_KEY);
}
