// Fabrica do EmbeddingClient para o caminho de request-time (busca).
//
// Ordem de preferencia: Gemini (`GEMINI_API_KEY`, provider preferido) > OpenAI
// (`OPENAI_API_KEY`). Quando NENHUMA chave esta provisionada, devolve um cliente
// cujo `embed()` lanca — `searchMemoria` captura essa falha e degrada para
// `lexical_only` (spec §8.2): a busca NUNCA pode morrer por falta de chave de
// embeddings.

import { config } from '../config.js';
import {
  makeGeminiEmbeddingClient,
  makeOpenAIEmbeddingClient,
  type EmbeddingClient,
} from './embeddings.js';

export function getEmbeddingClient(): EmbeddingClient {
  if (config.GEMINI_API_KEY) {
    return makeGeminiEmbeddingClient(config.GEMINI_API_KEY);
  }
  if (config.OPENAI_API_KEY) {
    return makeOpenAIEmbeddingClient(config.OPENAI_API_KEY);
  }
  return {
    model: 'unconfigured',
    embed: async () => {
      throw new Error('nenhum provider de embeddings configurado (GEMINI_API_KEY/OPENAI_API_KEY ausentes)');
    },
  };
}
