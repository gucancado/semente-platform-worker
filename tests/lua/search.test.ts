import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { searchMemoria } from '../../src/lua/search.js';
import type { EmbeddingClient } from '../../src/lua/embeddings.js';

// ── Fakes de embedding client (deterministicos, SEM rede) ──────────────────
//
// Estrategia: vetores one-hot 1024-dim. A query e embedada como one-hot na
// dimensao D; o chunk/fato cuja seed casa essa dimensao tem distancia cosseno 0
// (vizinho perfeito) e domina o braco vetorial.

function oneHot(dim: number): number[] {
  const v = new Array(1024).fill(0);
  v[dim] = 1;
  return v;
}

/** Query sempre embedada como one-hot na dimensao `dim`. */
function fakeQueryEmbedder(dim: number): EmbeddingClient {
  return {
    model: 'fake@1024',
    async embed(xs: string[]): Promise<number[][]> {
      return xs.map(() => oneHot(dim));
    },
  };
}

/** Embedder que sempre falha (simula API de embedding fora do ar). */
const throwingEmbedder: EmbeddingClient = {
  model: 'fake@1024',
  async embed(): Promise<number[][]> {
    throw new Error('embedding API indisponivel');
  },
};

// ── Seed helpers ───────────────────────────────────────────────────────────

function toVec(v: number[]): string {
  return `[${v.join(',')}]`;
}

async function seedEpisode(args: {
  externalId: string;
  workspaceId: string;
  title: string;
  occurredAt?: string;
}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO episodes
       (fonte, external_source, external_id, title, occurred_at, workspace_id, revision)
     VALUES ('reuniao', 'fireflies', $1, $2, $3, $4, 1)
     RETURNING id`,
    [args.externalId, args.title, args.occurredAt ?? '2026-05-01T14:00:00Z', args.workspaceId]
  );
  return Number(rows[0]!.id);
}

async function seedChunk(args: {
  episodeId: number;
  workspaceId: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
  turnStart?: number;
  turnEnd?: number;
}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO episode_chunks
       (episode_id, episode_revision, workspace_id, chunk_index,
        turn_start, turn_end, text, token_count, embedding, embedding_model)
     VALUES ($1, 1, $2, $3, $4, $5, $6, 10, $7::vector, 'fake@1024')
     RETURNING id`,
    [
      args.episodeId,
      args.workspaceId,
      args.chunkIndex,
      args.turnStart ?? 0,
      args.turnEnd ?? 1,
      args.text,
      toVec(args.embedding),
    ]
  );
  return Number(rows[0]!.id);
}

async function seedFact(args: {
  episodeId: number;
  workspaceId: string;
  factType: string;
  statement: string;
  embedding: number[];
  validAt?: string;
  invalidAt?: string | null;
  invalidationReason?: string | null;
}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO facts
       (workspace_id, fact_type, statement, confidence,
        valid_at, invalid_at, invalidation_reason,
        episode_id, episode_revision, turn_start, turn_end,
        embedding, embedding_model, extracted_by)
     VALUES ($1, $2, $3, 0.9,
             $4, $5, $6,
             $7, 1, 41, 44,
             $8::vector, 'fake@1024', 'fake-extractor')
     RETURNING id`,
    [
      args.workspaceId,
      args.factType,
      args.statement,
      args.validAt ?? '2026-05-01T14:00:00Z',
      args.invalidAt ?? null,
      args.invalidationReason ?? null,
      args.episodeId,
      toVec(args.embedding),
    ]
  );
  return Number(rows[0]!.id);
}

beforeEach(async () => {
  await pool.query(
    `TRUNCATE episode_chunks, facts, episodes RESTART IDENTITY CASCADE`
  );
});

after(async () => {
  await pool.end();
});

// ── 1. Isolamento por workspace (invariante inviolavel) ────────────────────

test('search_memoria so retorna itens do workspace pedido (zero vazamento)', async () => {
  // w1: chunk cujo vetor casa a query (one-hot dim 7).
  const ep1 = await seedEpisode({ externalId: 'e1', workspaceId: 'w1', title: 'Reuniao W1' });
  await seedChunk({
    episodeId: ep1,
    workspaceId: 'w1',
    chunkIndex: 0,
    text: 'Gustavo: a verba de junho sobe para 8k na conta.',
    embedding: oneHot(7),
  });
  // w2: chunk com o MESMO vetor casando a query — nao pode vazar.
  const ep2 = await seedEpisode({ externalId: 'e2', workspaceId: 'w2', title: 'Reuniao W2' });
  await seedChunk({
    episodeId: ep2,
    workspaceId: 'w2',
    chunkIndex: 0,
    text: 'Outro cliente, outra verba de junho.',
    embedding: oneHot(7),
  });

  const res = await searchMemoria(
    { workspaceId: 'w1', query: 'verba de junho' },
    {},
    { embeddingClient: fakeQueryEmbedder(7) }
  );

  assert.equal(res.schema, 'memoria_search_v1');
  assert.ok(res.results.length >= 1, 'esperava ao menos 1 resultado');
  for (const r of res.results) {
    if (r.kind === 'chunk') {
      assert.equal(r.provenance.episode_id, ep1, 'chunk de outro workspace vazou');
    }
  }
  // Nenhum resultado pode referenciar o episodio de w2.
  assert.ok(
    res.results.every((r) => r.provenance.episode_id !== ep2),
    'resultado de w2 vazou para busca de w1'
  );
});

// ── 2. Proveniencia completa do chunk (titulo + occurred_at) ───────────────

test('chunk hit traz proveniencia completa (titulo, occurred_at, janela de turnos)', async () => {
  const ep = await seedEpisode({
    externalId: 'e1',
    workspaceId: 'w1',
    title: 'Alinhamento Tagless',
    occurredAt: '2026-05-02T14:00:00Z',
  });
  await seedChunk({
    episodeId: ep,
    workspaceId: 'w1',
    chunkIndex: 0,
    text: 'Gustavo: a verba mensal fechou.',
    embedding: oneHot(3),
    turnStart: 12,
    turnEnd: 19,
  });

  const res = await searchMemoria(
    { workspaceId: 'w1', query: 'verba mensal' },
    { scope: 'episodios' },
    { embeddingClient: fakeQueryEmbedder(3) }
  );

  const hit = res.results.find((r) => r.kind === 'chunk');
  assert.ok(hit && hit.kind === 'chunk', 'esperava um chunk hit');
  assert.equal(hit.text, 'Gustavo: a verba mensal fechou.');
  assert.equal(hit.provenance.episode_id, ep);
  assert.equal(hit.provenance.episode_title, 'Alinhamento Tagless');
  assert.equal(hit.provenance.turn_start, 12);
  assert.equal(hit.provenance.turn_end, 19);
  assert.ok(hit.provenance.occurred_at.startsWith('2026-05-02'));
});

// ── 3. Braco lexical funciona mesmo com vetor irrelevante; fusao RRF poe o
//      item duplamente casado no topo ──────────────────────────────────────

test('braco lexical recupera linha com vetor irrelevante; item duplo lidera RRF', async () => {
  const ep = await seedEpisode({ externalId: 'e1', workspaceId: 'w1', title: 'Reuniao' });

  // A: casa a query SO no lexico (vetor numa dimensao que a query nao ativa).
  const aId = await seedChunk({
    episodeId: ep,
    workspaceId: 'w1',
    chunkIndex: 0,
    text: 'Decidimos o orcamento de marketing para a campanha.',
    embedding: oneHot(500),
  });
  // B: casa a query no LEXICO e no VETOR (one-hot dim 7 == query) → duplo match.
  const bId = await seedChunk({
    episodeId: ep,
    workspaceId: 'w1',
    chunkIndex: 1,
    text: 'O orcamento de marketing precisa subir no proximo mes.',
    embedding: oneHot(7),
  });
  // C: casa SO no vetor (texto sem o termo), dimensao diferente da query.
  await seedChunk({
    episodeId: ep,
    workspaceId: 'w1',
    chunkIndex: 2,
    text: 'Conversamos sobre logistica e entregas.',
    embedding: oneHot(900),
  });

  const res = await searchMemoria(
    { workspaceId: 'w1', query: 'orcamento de marketing' },
    { scope: 'episodios' },
    { embeddingClient: fakeQueryEmbedder(7) }
  );

  // A (lexical-only) deve aparecer apesar do vetor irrelevante.
  const texts = res.results.map((r) => (r.kind === 'chunk' ? r.text : ''));
  assert.ok(
    texts.some((t) => t.includes('campanha')),
    'chunk casado so no lexico nao apareceu'
  );

  // B (duplo match: lexical + vetorial) deve liderar a fusao RRF.
  const top = res.results[0];
  assert.ok(top && top.kind === 'chunk', 'topo deveria ser chunk');
  assert.equal(top.provenance.episode_id, ep);
  assert.ok(
    top.text.includes('proximo mes'),
    `esperava o item de duplo match no topo, veio: ${top.text}`
  );
  void aId;
  void bId;
});

// ── 4. Fallback: embedding cai → degraded lexical_only, resultados do lexico ─

test('embedding indisponivel => degraded lexical_only com resultados do braco lexical', async () => {
  const ep = await seedEpisode({ externalId: 'e1', workspaceId: 'w1', title: 'Reuniao' });
  await seedChunk({
    episodeId: ep,
    workspaceId: 'w1',
    chunkIndex: 0,
    text: 'O relatorio de performance ficou pronto.',
    embedding: oneHot(11),
  });

  const res = await searchMemoria(
    { workspaceId: 'w1', query: 'relatorio de performance' },
    { scope: 'episodios' },
    { embeddingClient: throwingEmbedder }
  );

  assert.equal(res.degraded, 'lexical_only');
  assert.ok(res.results.length >= 1, 'lexical deveria retornar a linha');
  const hit = res.results[0];
  assert.ok(hit && hit.kind === 'chunk');
  assert.ok(hit.text.includes('relatorio'));
});

// ── 5. Scope 'fatos' retorna apenas fatos ──────────────────────────────────

test("scope 'fatos' retorna apenas kind fato; 'episodios' apenas chunks", async () => {
  const ep = await seedEpisode({ externalId: 'e1', workspaceId: 'w1', title: 'Reuniao' });
  await seedChunk({
    episodeId: ep,
    workspaceId: 'w1',
    chunkIndex: 0,
    text: 'A verba mensal de midia foi definida.',
    embedding: oneHot(7),
  });
  await seedFact({
    episodeId: ep,
    workspaceId: 'w1',
    factType: 'decisao',
    statement: 'A verba mensal de midia da Tagless e R$ 8.000',
    embedding: oneHot(7),
  });

  const fatos = await searchMemoria(
    { workspaceId: 'w1', query: 'verba mensal de midia' },
    { scope: 'fatos' },
    { embeddingClient: fakeQueryEmbedder(7) }
  );
  assert.ok(fatos.results.length >= 1);
  assert.ok(fatos.results.every((r) => r.kind === 'fato'), 'scope fatos vazou chunk');
  const f = fatos.results[0];
  assert.ok(f && f.kind === 'fato');
  assert.equal(f.fact_type, 'decisao');
  assert.ok(typeof f.fact_id === 'number');
  assert.equal(f.needs_review, false);
  assert.equal(f.invalid_at, null);

  const eps = await searchMemoria(
    { workspaceId: 'w1', query: 'verba mensal de midia' },
    { scope: 'episodios' },
    { embeddingClient: fakeQueryEmbedder(7) }
  );
  assert.ok(eps.results.length >= 1);
  assert.ok(eps.results.every((r) => r.kind === 'chunk'), 'scope episodios vazou fato');
});

// ── 6. Fatos invalidos fora do default; includeInvalid os traz de volta ────

test('fatos invalidos excluidos por default; includeInvalid habilita', async () => {
  const ep = await seedEpisode({ externalId: 'e1', workspaceId: 'w1', title: 'Reuniao' });
  await seedFact({
    episodeId: ep,
    workspaceId: 'w1',
    factType: 'decisao',
    statement: 'Verba antiga de midia era R$ 5.000',
    embedding: oneHot(7),
    invalidAt: '2026-05-10T00:00:00Z',
    invalidationReason: 'superseded',
  });

  const def = await searchMemoria(
    { workspaceId: 'w1', query: 'verba de midia' },
    { scope: 'fatos' },
    { embeddingClient: fakeQueryEmbedder(7) }
  );
  assert.equal(def.results.length, 0, 'fato invalido nao deve entrar no default');

  const arq = await searchMemoria(
    { workspaceId: 'w1', query: 'verba de midia' },
    { scope: 'fatos', includeInvalid: true },
    { embeddingClient: fakeQueryEmbedder(7) }
  );
  assert.ok(arq.results.length >= 1, 'includeInvalid deveria trazer o fato invalido');
  const f = arq.results[0];
  assert.ok(f && f.kind === 'fato');
  assert.ok(f.invalid_at !== null);
});

// ── 7. Filtro de periodo (since/until) ─────────────────────────────────────

test('since/until filtram por occurred_at (chunk) e valid_at (fato)', async () => {
  const epOld = await seedEpisode({
    externalId: 'e-old',
    workspaceId: 'w1',
    title: 'Antiga',
    occurredAt: '2026-01-01T10:00:00Z',
  });
  await seedChunk({
    episodeId: epOld,
    workspaceId: 'w1',
    chunkIndex: 0,
    text: 'verba antiga discutida em janeiro',
    embedding: oneHot(7),
  });
  const epNew = await seedEpisode({
    externalId: 'e-new',
    workspaceId: 'w1',
    title: 'Recente',
    occurredAt: '2026-05-01T10:00:00Z',
  });
  await seedChunk({
    episodeId: epNew,
    workspaceId: 'w1',
    chunkIndex: 0,
    text: 'verba recente discutida em maio',
    embedding: oneHot(7),
  });

  const res = await searchMemoria(
    { workspaceId: 'w1', query: 'verba' },
    { scope: 'episodios', since: '2026-04-01T00:00:00Z' },
    { embeddingClient: fakeQueryEmbedder(7) }
  );
  assert.ok(res.results.length >= 1);
  assert.ok(
    res.results.every((r) => r.provenance.episode_id === epNew),
    'since deveria excluir o episodio de janeiro'
  );
});

// ── 8. Clamp de k ──────────────────────────────────────────────────────────

test('k e clampado em [1,30]', async () => {
  const ep = await seedEpisode({ externalId: 'e1', workspaceId: 'w1', title: 'Reuniao' });
  for (let i = 0; i < 5; i++) {
    await seedChunk({
      episodeId: ep,
      workspaceId: 'w1',
      chunkIndex: i,
      text: `chunk ${i} sobre verba e orcamento`,
      embedding: oneHot(7),
    });
  }
  const res = await searchMemoria(
    { workspaceId: 'w1', query: 'verba orcamento' },
    { scope: 'episodios', k: 999 },
    { embeddingClient: fakeQueryEmbedder(7) }
  );
  assert.ok(res.results.length <= 30, 'k acima de 30 deveria ser clampado');

  const res2 = await searchMemoria(
    { workspaceId: 'w1', query: 'verba orcamento' },
    { scope: 'episodios', k: 1 },
    { embeddingClient: fakeQueryEmbedder(7) }
  );
  assert.equal(res2.results.length, 1, 'k=1 deveria retornar 1 resultado');
});
