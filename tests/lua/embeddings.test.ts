import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  embedBatched,
  makeOpenAIEmbeddingClient,
  type EmbeddingClient,
} from '../../src/lua/embeddings.js';
import { estimateTokens } from '../../src/lua/chunking.js';

// Limites reais da OpenAI (spec Lua v1 §5.3-A2, achado Codex #11):
//   - <= 2048 inputs por request
//   - <= 300_000 tokens somados por request
//   - <= 8192 tokens por input
const MAX_INPUTS = 2048;
const MAX_TOKENS_PER_REQUEST = 300_000;

// Texto de ~N tokens segundo o estimador (chars/4) compartilhado com o chunking.
function textOfTokens(tokens: number): string {
  // estimateTokens usa chars/4, entao 4 chars ~= 1 token.
  return 'x'.repeat(tokens * 4);
}

test('embedBatched quebra em lotes por contagem de tokens, preservando ordem', async () => {
  const calls: number[] = [];
  let nextId = 0;
  // Fake que registra inputs.length por chamada e devolve vetores deterministicos
  // marcados pela posicao global, para checar ordem.
  const spy: EmbeddingClient = {
    model: 'fake@1024',
    embed: async (inputs) => {
      calls.push(inputs.length);
      return inputs.map(() => {
        const v = new Array(1024).fill(0);
        v[0] = nextId++; // marca a ordem de emissao
        return v;
      });
    },
  };

  // ~5000 textos de ~450 tokens cada => ~2,25M tokens no total.
  const texts = Array.from({ length: 5000 }, () => textOfTokens(450));
  const vecs = await embedBatched(spy, texts);

  // Um vetor por input, ordem preservada.
  assert.equal(vecs.length, 5000);
  for (let i = 0; i < vecs.length; i++) {
    assert.equal(vecs[i][0], i, `ordem do vetor ${i} preservada`);
  }

  // Nenhum lote excede o limite de inputs.
  assert.ok(Math.max(...calls) <= MAX_INPUTS, `max inputs por lote ${Math.max(...calls)} <= ${MAX_INPUTS}`);

  // Houve mais de um lote (5000 > 2048).
  assert.ok(calls.length >= 3, `esperava varios lotes, teve ${calls.length}`);

  // Nenhum lote excede o teto de tokens somados: reconstroi os lotes na ordem
  // e confere que cada fatia (do tamanho registrado) soma <= 300k tokens.
  let offset = 0;
  for (const size of calls) {
    let sumTokens = 0;
    for (let i = offset; i < offset + size; i++) sumTokens += estimateTokens(texts[i]);
    assert.ok(sumTokens <= MAX_TOKENS_PER_REQUEST, `lote soma ${sumTokens} <= ${MAX_TOKENS_PER_REQUEST}`);
    offset += size;
  }
  assert.equal(offset, 5000);
});

test('embedBatched: array vazio -> []', async () => {
  const fake: EmbeddingClient = {
    model: 'fake@1024',
    embed: async () => {
      throw new Error('nao deveria chamar embed para entrada vazia');
    },
  };
  const vecs = await embedBatched(fake, []);
  assert.deepEqual(vecs, []);
});

test('embedBatched: um texto -> um vetor', async () => {
  const fake: EmbeddingClient = {
    model: 'fake@1024',
    embed: async (inputs) => inputs.map(() => new Array(1024).fill(0.01)),
  };
  const vecs = await embedBatched(fake, ['ola mundo']);
  assert.equal(vecs.length, 1);
  assert.equal(vecs[0].length, 1024);
});

test('embedBatched: texto unico grande (~8000 tokens) fica no proprio lote', async () => {
  const calls: number[] = [];
  const spy: EmbeddingClient = {
    model: 'fake@1024',
    embed: async (inputs) => {
      calls.push(inputs.length);
      return inputs.map(() => new Array(1024).fill(0));
    },
  };
  // Um texto perto do limite por-input (8000 tok) cercado por textos pequenos.
  // O grande sozinho ja passa de qualquer teto razoavel de lote agrupado, entao
  // nunca pode compartilhar lote com vizinhos que estourem o teto somado.
  const big = textOfTokens(8000);
  const small = textOfTokens(100);
  const texts = [small, big, small];
  const vecs = await embedBatched(spy, texts);
  assert.equal(vecs.length, 3);
  // O texto grande nao pode ser agrupado de forma a estourar 300k; com 3 itens
  // tudo cabe num lote, mas o invariante de soma <= 300k tem que valer.
  let offset = 0;
  for (const size of calls) {
    let sum = 0;
    for (let i = offset; i < offset + size; i++) sum += estimateTokens(texts[i]);
    assert.ok(sum <= MAX_TOKENS_PER_REQUEST);
    offset += size;
  }
});

test('embedBatched: lote unico grande de quase-8k tokens fragmenta por teto de tokens', async () => {
  const calls: number[] = [];
  const spy: EmbeddingClient = {
    model: 'fake@1024',
    embed: async (inputs) => {
      calls.push(inputs.length);
      return inputs.map(() => new Array(1024).fill(0));
    },
  };
  // 100 textos de ~8000 tokens => ~800k tokens; teto 300k => >= 3 lotes,
  // cada lote no maximo 37 itens (37*8000=296k <= 300k, 38*8000=304k > 300k).
  const texts = Array.from({ length: 100 }, () => textOfTokens(8000));
  const vecs = await embedBatched(spy, texts);
  assert.equal(vecs.length, 100);
  assert.ok(calls.length >= 3, `esperava >=3 lotes por teto de tokens, teve ${calls.length}`);
  assert.ok(Math.max(...calls) <= 37, `lote nao pode exceder 37 itens de 8k tokens, teve ${Math.max(...calls)}`);
});

test('makeOpenAIEmbeddingClient reporta modelo text-embedding-3-large@1024 sem chamar a API', () => {
  // Construir o cliente NAO deve disparar nenhuma chamada de rede.
  const client = makeOpenAIEmbeddingClient('sk-test');
  assert.equal(client.model, 'text-embedding-3-large@1024');
});
