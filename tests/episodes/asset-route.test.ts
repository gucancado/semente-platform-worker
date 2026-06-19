import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';

// Definir env vars ANTES dos imports dinâmicos para que o config seja parseado corretamente
process.env.OWNER_ADMIN_TOKEN = '0123456789abcdef0123456789abcdef';
process.env.AGENT_TOKENS_JSON = JSON.stringify({ mercurio: { worker_token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
process.env.R2_ENDPOINT = 'https://acc.r2.cloudflarestorage.com';
process.env.R2_ACCESS_KEY_ID = 'k';
process.env.R2_SECRET_ACCESS_KEY = 's';
process.env.R2_BUCKET_EPISODES = 'semente-episodios-prod';

const { pool } = await import('../../src/db.js');
const { insertEpisodeWithTurns } = await import('../../src/episodes/db.js');
const { registerEpisodesRoutes } = await import('../../src/episodes/routes.js');

const ownerAuth = { 'x-owner-token': '0123456789abcdef0123456789abcdef' };
function buildApp(): FastifyInstance { const a = Fastify(); a.register(registerEpisodesRoutes); return a; }

const EP = {
  fonte: 'reuniao' as const, external_source: 'fireflies', external_id: 'ff-asset-1',
  title: 'Ep Asset', occurred_at: new Date('2026-05-01T14:00:00Z'), duration_seconds: 60,
  participants: [], metadata: {}, raw_r2_key: 'fireflies/ff-asset-1.json', audio_r2_key: null,
  workspace_id: 'wks-1', project_slug: null, attribution_method: 'manual',
  turns: [{ turn_index: 0, speaker_name: 'Ana', speaker_label: 'Ana', text: 'oi' }],
};

beforeEach(async () => {
  await pool.query('TRUNCATE episode_turns, episodes, event_outbox_deliveries, event_outbox RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('asset sem owner-token → 401', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/episodes/1/asset?kind=raw' });
  assert.equal(res.statusCode, 401);
});

test('asset kind inválido → 400', async () => {
  const { id } = await insertEpisodeWithTurns(EP);
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: `/episodes/${id}/asset?kind=foo`, headers: ownerAuth });
  assert.equal(res.statusCode, 400);
});

test('asset raw com chave presente → 302 com Location presigned', async () => {
  const { id } = await insertEpisodeWithTurns(EP);
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: `/episodes/${id}/asset?kind=raw`, headers: ownerAuth });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location as string, /X-Amz-Signature=/);
});

test('asset audio com chave nula → 404', async () => {
  const { id } = await insertEpisodeWithTurns(EP);
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: `/episodes/${id}/asset?kind=audio`, headers: ownerAuth });
  assert.equal(res.statusCode, 404);
});
