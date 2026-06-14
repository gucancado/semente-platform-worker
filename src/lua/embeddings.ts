// Cliente de embeddings da Lua (spec Lua v1 §5.3-A2, §5.4).
//
// Interface injetavel: o pipeline recebe um EmbeddingClient por parametro, de
// modo que os testes usam fakes deterministicos e nunca tocam a rede (decisao
// da spec §15.3). O batching respeita os tres limites reais da OpenAI
// (achado Codex #11): <=2048 inputs/request, <=300_000 tokens somados/request,
// <=8192 tokens/input — dimensionando o lote por CONTAGEM DE TOKENS, nao so por
// quantidade de itens.

import OpenAI from 'openai';
import { estimateTokens } from './chunking.js';

/** Cliente de embeddings injetavel. Uma implementacao real (OpenAI) e fakes nos testes. */
export interface EmbeddingClient {
  /** Identificador do modelo, ex.: 'text-embedding-3-large@1024'. */
  model: string;
  /** Recebe N textos, devolve N vetores (1024 dims cada), na mesma ordem. */
  embed(inputs: string[]): Promise<number[][]>;
}

// Limites reais da OpenAI embeddings (spec §5.3-A2).
const MAX_INPUTS_PER_REQUEST = 2048;
const MAX_TOKENS_PER_REQUEST = 300_000;

/**
 * Embeda `texts` em lotes que respeitam TODOS os limites da OpenAI, chamando
 * `client.embed` uma vez por lote e concatenando os resultados na ordem de
 * entrada. Um vetor por texto, ordem preservada.
 *
 * O lote acumula itens enquanto couber em <=2048 inputs E <=300k tokens somados.
 * Um item cujo tamanho sozinho ja estoure o teto de tokens ocupa um lote so (o
 * chunking garante <=700 tokens/chunk por construcao, mas o batcher e robusto a
 * itens grandes para nao perder entradas).
 */
export async function embedBatched(
  client: EmbeddingClient,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const out: number[][] = [];
  let batch: string[] = [];
  let batchTokens = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const vecs = await client.embed(batch);
    for (const v of vecs) out.push(v);
    batch = [];
    batchTokens = 0;
  };

  for (const text of texts) {
    const tokens = estimateTokens(text);
    const wouldExceedInputs = batch.length + 1 > MAX_INPUTS_PER_REQUEST;
    const wouldExceedTokens = batch.length > 0 && batchTokens + tokens > MAX_TOKENS_PER_REQUEST;
    if (wouldExceedInputs || wouldExceedTokens) {
      await flush();
    }
    batch.push(text);
    batchTokens += tokens;
  }
  await flush();

  return out;
}

/**
 * Cria um EmbeddingClient real sobre o pacote `openai`, modelo
 * `text-embedding-3-large` com `dimensions: 1024` (decisao de substrato v1.4).
 * Construir o cliente NAO faz chamada de rede. O batcher (embedBatched) e quem
 * respeita os limites de lote; aqui so chamamos a API com os inputs ja fatiados.
 */
export function makeOpenAIEmbeddingClient(
  apiKey: string,
  opts?: { model?: string; dimensions?: number },
): EmbeddingClient {
  const model = opts?.model ?? 'text-embedding-3-large';
  const dimensions = opts?.dimensions ?? 1024;
  const client = new OpenAI({ apiKey });
  return {
    model: `${model}@${dimensions}`,
    async embed(inputs: string[]): Promise<number[][]> {
      if (inputs.length === 0) return [];
      const res = await client.embeddings.create({ model, input: inputs, dimensions });
      // A API garante a ordem; ordenamos por index por seguranca.
      return res.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding as number[]);
    },
  };
}

// Limite do batchEmbedContents da Generative Language API: <=100 requests/chamada.
const GEMINI_MAX_REQUESTS_PER_CALL = 100;

/** Normalizacao L2: divide cada componente pela norma euclidiana. Norma 0 -> vetor inalterado. */
function l2normalize(v: number[]): number[] {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

/**
 * Cria um EmbeddingClient real sobre a Generative Language API (Gemini),
 * modelo `gemini-embedding-001` com `dimensions: 1024` (decisao de substrato v1.4,
 * preferido sobre OpenAI). Detalhes de implementacao:
 *
 * - REST puro via `fetch` global (Node 24) — sem dependencia nova (nada de
 *   googleapis/@google).
 * - O endpoint `batchEmbedContents` aceita no maximo 100 requests por chamada;
 *   como `embedBatched` pode entregar ate 2048 inputs de uma vez, o `embed()`
 *   sub-fatia internamente em blocos de <=100 e concatena preservando a ordem global.
 * - Normalizacao L2 obrigatoria: com `outputDimensionality < 3072` o modelo
 *   retorna vetores NAO normalizados; o pgvector da Lua usa distancia cosseno e
 *   espera vetores normalizados, entao aplicamos L2-normalize em cada vetor.
 *
 * Construir o cliente NAO faz chamada de rede.
 */
export function makeGeminiEmbeddingClient(
  apiKey: string,
  opts?: { model?: string; dimensions?: number },
): EmbeddingClient {
  const model = opts?.model ?? 'gemini-embedding-001';
  const dimensions = opts?.dimensions ?? 1024;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`;

  return {
    model: `${model}@${dimensions}`,
    async embed(inputs: string[]): Promise<number[][]> {
      if (inputs.length === 0) return [];

      const out: number[][] = [];
      // Sub-fatia em blocos de <=100 (limite do batchEmbedContents).
      for (let start = 0; start < inputs.length; start += GEMINI_MAX_REQUESTS_PER_CALL) {
        const slice = inputs.slice(start, start + GEMINI_MAX_REQUESTS_PER_CALL);
        const body = {
          requests: slice.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            outputDimensionality: dimensions,
            taskType: 'SEMANTIC_SIMILARITY',
          })),
        };
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`Gemini embeddings ${res.status}: ${errBody}`);
        }
        const json = (await res.json()) as { embeddings: Array<{ values: number[] }> };
        // A API devolve na MESMA ordem das requests; normalizamos cada vetor (L2).
        for (const e of json.embeddings) out.push(l2normalize(e.values));
      }
      return out;
    },
  };
}
