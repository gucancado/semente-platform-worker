import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { pool } from '../../src/db.js';
import { insertEpisodeWithTurns } from '../../src/episodes/db.js';
import { registerEpisodesRoutes } from '../../src/episodes/routes.js';

// Env pra testes
process.env.OWNER_ADMIN_TOKEN = '0123456789abcdef0123456789abcdef';
process.env.AGENT_TOKENS_JSON = JSON.stringify({
  mercurio: { worker_token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
});

const AGENT_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWNER_TOKEN = '0123456789abcdef0123456789abcdef';

const agentAuth = { 'x-agent-token': AGENT_TOKEN };
const ownerAuth = { 'x-owner-token': OWNER_TOKEN };

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.register(registerEpisodesRoutes);
  return app;
}

const BASE_EPISODE = {
  fonte: 'reuniao' as const,
  external_source: 'fireflies',
  external_id: 'ff-test-routes-1',
  title: 'Reunião de Teste de Rotas',
  occurred_at: new Date('2026-05-01T14:00:00Z'),
  duration_seconds: 1800,
  participants: [{ name: 'Ana', email: 'ana@test.com' }],
  metadata: {},
  raw_r2_key: 'fireflies/ff-test.json',
  audio_r2_key: 'fireflies/ff-test.m4a',
  workspace_id: 'wks-1',
  project_slug: 'tagless-brasil',
  attribution_method: 'domain',
  turns: [
    { turn_index: 0, speaker_name: 'Ana', speaker_label: 'Ana', text: 'Oi, tudo bem?' },
    { turn_index: 1, speaker_name: 'Gustavo', speaker_label: 'Gustavo', text: 'Tudo! Vamos começar.' },
  ],
};

beforeEach(async () => {
  await pool.query(
    'TRUNCATE episode_turns, episodes, event_outbox_deliveries, event_outbox RESTART IDENTITY CASCADE'
  );
});

after(() => pool.end());

// 1. GET /episodes sem X-Agent-Token → 401
test('GET /episodes sem X-Agent-Token → 401', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/episodes' });
  assert.equal(res.statusCode, 401);
});

// 2. GET /episodes?workspace_id=wks-1 com token válido → 200, body tem schema e items sem turns
test('GET /episodes?workspace_id=wks-1 com token válido → 200, schema episodio_v1, items sem turns', async () => {
  await insertEpisodeWithTurns(BASE_EPISODE);
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/episodes?workspace_id=wks-1',
    headers: agentAuth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schema, 'episodio_v1');
  assert.ok(Array.isArray(body.items));
  assert.equal(body.items.length, 1);
  // items não devem ter turns inline
  assert.equal('turns' in body.items[0], false);
  assert.equal(body.items[0].workspace_id, 'wks-1');
});

// 3. GET /episodes/:id → 200 com turns e provenance
test('GET /episodes/:id → 200 com turns e provenance', async () => {
  const { id } = await insertEpisodeWithTurns(BASE_EPISODE);
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/episodes/${id}`,
    headers: agentAuth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schema, 'episodio_v1');
  assert.ok(Array.isArray(body.turns));
  assert.equal(body.turns.length, 2);
  assert.ok(body.provenance);
  assert.equal(body.provenance.external_source, 'fireflies');
  assert.equal(body.provenance.external_id, 'ff-test-routes-1');
  assert.equal(body.provenance.raw_r2_key, 'fireflies/ff-test.json');
  assert.equal(body.provenance.audio_r2_key, 'fireflies/ff-test.m4a');
});

// 4. GET /episodes/:id/turns?from=0&to=0 → 200 com 1 turno
test('GET /episodes/:id/turns?from=0&to=0 → 200 janela com 1 turno', async () => {
  const { id } = await insertEpisodeWithTurns(BASE_EPISODE);
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/episodes/${id}/turns?from=0&to=0`,
    headers: agentAuth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schema, 'episodio_v1');
  assert.equal(body.episode_id, Number(id));
  assert.ok(Array.isArray(body.turns));
  assert.equal(body.turns.length, 1);
  assert.equal(body.turns[0].turn_index, 0);
  assert.equal(body.turns[0].text, 'Oi, tudo bem?');
});

// 5. GET /episodes/999999 → 404
test('GET /episodes/999999 → 404', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/episodes/999999',
    headers: agentAuth,
  });
  assert.equal(res.statusCode, 404);
});

// 6a. PATCH /admin/episodes/:id/attribution sem X-Owner-Token → 401
test('PATCH /admin/episodes/:id/attribution sem X-Owner-Token → 401', async () => {
  const { id } = await insertEpisodeWithTurns(BASE_EPISODE);
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/admin/episodes/${id}/attribution`,
    payload: { workspace_id: 'wks-9' },
  });
  assert.equal(res.statusCode, 401);
});

// 6b. PATCH /admin/episodes/:id/attribution com X-Owner-Token → 200, attribution_method='manual'
test('PATCH /admin/episodes/:id/attribution com X-Owner-Token → 200, attribution_method=manual', async () => {
  const { id } = await insertEpisodeWithTurns({
    ...BASE_EPISODE,
    external_id: 'ff-test-routes-2',
    workspace_id: null,
    attribution_method: 'none',
  });
  const app = buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/admin/episodes/${id}/attribution`,
    headers: ownerAuth,
    payload: { workspace_id: 'wks-9' },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);

  // Verificar que attribution_method foi atualizado no DB
  const { rows } = await pool.query(`SELECT attribution_method FROM episodes WHERE id=$1`, [id]);
  assert.equal(rows[0].attribution_method, 'manual');
});

// 7. GET /admin/outbox/dead → 200 com items vazio
test('GET /admin/outbox/dead → 200 com items: []', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/admin/outbox/dead',
    headers: ownerAuth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.items));
  assert.equal(body.items.length, 0);
});

// 8. GET /episodes/abc → 400 (id inválido)
test('GET /episodes/abc → 400 id inválido', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: '/episodes/abc',
    headers: agentAuth,
  });
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'id inválido');
});

// 9. GET /episodes?cursor=%%% → 400 cursor inválido
test('GET /episodes?cursor=%%% → 400 cursor inválido', async () => {
  const app = buildApp();
  // %%% is not valid base64url and produces no pipe character when decoded
  const res = await app.inject({
    method: 'GET',
    url: '/episodes?cursor=%25%25%25',
    headers: agentAuth,
  });
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'cursor inválido');
});
