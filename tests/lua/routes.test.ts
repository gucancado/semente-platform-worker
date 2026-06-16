import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { pool } from '../../src/db.js';
import { registerMemoriaRoutes } from '../../src/lua/routes.js';

// Token de agente vem do env-file c:/tmp/lua-test.env (agent `test`,
// worker_token `testworkertoken`). OPENAI_API_KEY ausente no env de teste, de
// modo que o provider degrada para lexical_only (prova o caminho ponta a ponta).
const AGENT_TOKEN = 'testworkertoken';
const agentAuth = { 'x-agent-token': AGENT_TOKEN };

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.register(registerMemoriaRoutes);
  return app;
}

// ── Seed direto via SQL (vetores sinteticos, episodio p/ proveniencia) ──────

function toVec(v: number[]): string {
  return `[${v.join(',')}]`;
}

function oneHot(dim: number): number[] {
  const v = new Array(1024).fill(0);
  v[dim] = 1;
  return v;
}

async function seedEpisode(externalId: string, workspaceId: string, title: string): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO episodes
       (fonte, external_source, external_id, title, occurred_at, workspace_id, revision)
     VALUES ('reuniao', 'fireflies', $1, $2, '2026-05-01T14:00:00Z', $3, 1)
     RETURNING id`,
    [externalId, title, workspaceId]
  );
  return Number(rows[0]!.id);
}

async function seedChunk(episodeId: number, workspaceId: string, chunkIndex: number, text: string): Promise<void> {
  await pool.query(
    `INSERT INTO episode_chunks
       (episode_id, episode_revision, workspace_id, chunk_index,
        turn_start, turn_end, text, token_count, embedding, embedding_model)
     VALUES ($1, 1, $2, $3, 0, 1, $4, 10, $5::vector, 'fake@1024')`,
    [episodeId, workspaceId, chunkIndex, text, toVec(oneHot(7))]
  );
}

beforeEach(async () => {
  await pool.query(`TRUNCATE episode_chunks, facts, episodes RESTART IDENTITY CASCADE`);
});

after(async () => {
  await pool.end();
});

// ── 1. Busca valida retorna 200, schema, degraded lexical_only, so do w1 ────

test('GET /memoria/search com token valido → 200, schema memoria_search_v1, degraded lexical_only, isolado por workspace', async () => {
  const ep1 = await seedEpisode('e1', 'w1', 'Reuniao W1');
  await seedChunk(ep1, 'w1', 0, 'Gustavo: a verba de junho sobe para 8k na conta.');
  // outro workspace com o mesmo termo lexical — nao pode vazar
  const ep2 = await seedEpisode('e2', 'w2', 'Reuniao W2');
  await seedChunk(ep2, 'w2', 0, 'Outro cliente, outra verba de junho.');

  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/memoria/search?workspace_id=w1&q=verba+de+junho',
    headers: agentAuth,
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schema, 'memoria_search_v1');
  // OPENAI_API_KEY ausente → braco vetorial pulado → degradacao graciosa.
  assert.equal(body.degraded, 'lexical_only');
  assert.ok(Array.isArray(body.results));
  assert.ok(body.results.length >= 1, 'esperava ao menos 1 resultado do w1');
  for (const r of body.results) {
    assert.equal(r.provenance.episode_id, ep1, 'resultado de outro workspace vazou');
  }
});

// ── 2. Validacao: workspace_id ausente → 400 ───────────────────────────────

test('GET /memoria/search sem workspace_id → 400', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/memoria/search?q=verba',
    headers: agentAuth,
  });
  assert.equal(res.statusCode, 400);
});

// ── 3. Validacao: q ausente → 400 ──────────────────────────────────────────

test('GET /memoria/search sem q → 400', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/memoria/search?workspace_id=w1',
    headers: agentAuth,
  });
  assert.equal(res.statusCode, 400);
});

// ── 4. Auth: sem X-Agent-Token → 401 ───────────────────────────────────────

test('GET /memoria/search sem X-Agent-Token → 401', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/memoria/search?workspace_id=w1&q=verba',
  });
  assert.equal(res.statusCode, 401);
});

// ── 5. Auth: X-Agent-Token invalido → 401 ──────────────────────────────────

test('GET /memoria/search com X-Agent-Token invalido → 401', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/memoria/search?workspace_id=w1&q=verba',
    headers: { 'x-agent-token': 'tokeninvalido' },
  });
  assert.equal(res.statusCode, 401);
});
