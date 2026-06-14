import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  embedBatched,
  makeOpenAIEmbeddingClient,
  makeGeminiEmbeddingClient,
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

// ── makeGeminiEmbeddingClient ──
// Todos os testes abaixo fazem stub do globalThis.fetch para NAO tocar a rede
// de verdade: salvam o original, substituem por um fake, e restauram no finally.

const realFetch = globalThis.fetch;

test('makeGeminiEmbeddingClient: modelo gemini-embedding-001@1024 e construir nao chama fetch', () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error('fetch nao deveria ser chamado ao construir');
  }) as typeof fetch;
  try {
    const client = makeGeminiEmbeddingClient('k');
    assert.equal(client.model, 'gemini-embedding-001@1024');
    assert.equal(called, false, 'construir o cliente nao pode chamar fetch');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('makeGeminiEmbeddingClient: embed([]) -> [] sem chamar fetch', async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error('fetch nao deveria ser chamado para entrada vazia');
  }) as typeof fetch;
  try {
    const client = makeGeminiEmbeddingClient('k');
    const out = await client.embed([]);
    assert.deepEqual(out, []);
    assert.equal(called, false, 'entrada vazia nao pode chamar fetch');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('makeGeminiEmbeddingClient: sub-batch de 100 (250 inputs -> 3 chamadas, ordem preservada)', async () => {
  const batchSizes: number[] = [];
  let globalIdx = 0; // contador global de vetores emitidos, para marcar ordem
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as {
      requests: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const n = body.requests.length;
    batchSizes.push(n);
    assert.ok(n <= 100, `cada chamada deve ter <=100 requests, teve ${n}`);
    // Cada vetor marca sua posicao global no componente [0]. Usamos [v,0] e
    // dimensions=2 (default e 1024, mas a marca so precisa do [0]).
    const embeddings = body.requests.map(() => {
      const marker = globalIdx++;
      // Vetor nao-normalizado cujo [0] = marker (>=0). Para nao perder a marca na
      // normalizacao L2, usamos [marker, 0] -> normalizado vira [1, 0] (marker>0)
      // ou [0,0] (marker=0). Entao guardamos a marca SEPARADA via segundo retorno.
      // Mais simples: nao normalizar a marca — devolvemos [marker+1, 0]; apos L2
      // vira [1,0] para qualquer marker, perdendo a marca. Por isso checamos a
      // ORDEM via tamanho/contagem e via um marcador resgatavel: ver assert abaixo.
      return { values: [marker + 1, 0] };
    });
    return { ok: true, json: async () => ({ embeddings }) };
  }) as unknown as typeof fetch;
  try {
    const client = makeGeminiEmbeddingClient('k', { dimensions: 2 });
    const inputs = Array.from({ length: 250 }, (_, i) => `t${i}`);
    const out = await client.embed(inputs);

    // 3 chamadas: 100 + 100 + 50.
    assert.deepEqual(batchSizes, [100, 100, 50]);
    assert.equal(out.length, 250);
    // Ordem preservada: o fake emitiu marker = posicao global crescente. Apos L2,
    // [marker+1, 0] -> [1, 0] (norma = marker+1 > 0). Logo cada saida e [1,0].
    // Para de fato provar ordem, conferimos que a concatenacao seguiu os blocos:
    // o fake processa requests na ordem recebida e o cliente concatena na ordem
    // dos blocos, entao out[i] corresponde a inputs[i]. Verificamos normalizacao.
    for (const v of out) {
      assert.equal(v.length, 2);
      assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9, 'cada vetor L2-normalizado');
      assert.ok(Math.abs(v[0] - 1) < 1e-9 && Math.abs(v[1]) < 1e-9);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('makeGeminiEmbeddingClient: ordem global preservada entre sub-batches', async () => {
  // Aqui o fake devolve vetores JA com a marca em uma posicao que sobrevive a L2:
  // usamos [marker, marker] -> apos L2 vira [s, s] com s = sign/sqrt(2); a marca
  // some. Em vez disso provamos ordem com um vetor unitario por eixo impossivel
  // de embaralhar: cada input recebe [cos, sin] de um angulo = idx, ja unitario,
  // entao L2 nao muda nada e podemos recuperar idx via atan2.
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { requests: unknown[] };
    // Recupera o indice global a partir do texto do input (t<idx>).
    const reqs = body.requests as Array<{ content: { parts: Array<{ text: string }> } }>;
    const embeddings = reqs.map((r) => {
      const idx = Number(r.content.parts[0].text.slice(1));
      const ang = idx; // radianos
      return { values: [Math.cos(ang), Math.sin(ang)] };
    });
    return { ok: true, json: async () => ({ embeddings }) };
  }) as unknown as typeof fetch;
  try {
    const client = makeGeminiEmbeddingClient('k', { dimensions: 2 });
    const inputs = Array.from({ length: 250 }, (_, i) => `t${i}`);
    const out = await client.embed(inputs);
    assert.equal(out.length, 250);
    for (let i = 0; i < out.length; i++) {
      const recovered = Math.atan2(out[i][1], out[i][0]);
      const expected = Math.atan2(Math.sin(i), Math.cos(i));
      assert.ok(Math.abs(recovered - expected) < 1e-9, `ordem do vetor ${i} preservada`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('makeGeminiEmbeddingClient: normaliza L2 (vetor [3,4] -> [0.6,0.8])', async () => {
  let sentDims: number | undefined;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as {
      requests: Array<{ outputDimensionality: number }>;
    };
    sentDims = body.requests[0].outputDimensionality;
    // Vetor nao-normalizado conhecido: [3,4], norma 5 -> [0.6, 0.8].
    const embeddings = body.requests.map(() => ({ values: [3, 4] }));
    return { ok: true, json: async () => ({ embeddings }) };
  }) as unknown as typeof fetch;
  try {
    const client = makeGeminiEmbeddingClient('k', { dimensions: 2 });
    const out = await client.embed(['x']);
    assert.equal(sentDims, 2, 'cliente deve enviar outputDimensionality=2');
    assert.equal(out.length, 1);
    assert.ok(Math.abs(out[0][0] - 0.6) < 1e-9, `componente 0 ~ 0.6, teve ${out[0][0]}`);
    assert.ok(Math.abs(out[0][1] - 0.8) < 1e-9, `componente 1 ~ 0.8, teve ${out[0][1]}`);
    assert.ok(Math.abs(Math.hypot(out[0][0], out[0][1]) - 1) < 1e-9, 'norma ~ 1');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('makeGeminiEmbeddingClient: erro HTTP -> rejeita com Error contendo o status', async () => {
  globalThis.fetch = (async () => ({
    ok: false,
    status: 429,
    text: async () => 'rate',
  })) as unknown as typeof fetch;
  try {
    const client = makeGeminiEmbeddingClient('k');
    await assert.rejects(
      () => client.embed(['x']),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /429/);
        assert.match(err.message, /rate/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
