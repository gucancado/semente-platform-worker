import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

// Credenciais R2 fake — presignGet computa a assinatura localmente (getSignedUrl não
// faz chamada de rede), então isso basta pra exercitar o 200 real. Precisa estar
// setado ANTES do parse de src/config.ts, por isso os imports abaixo são dinâmicos
// (mesmo padrão de tests/episodes/asset-route.test.ts).
process.env.R2_ENDPOINT = 'https://acc.r2.cloudflarestorage.com';
process.env.R2_ACCESS_KEY_ID = 'k';
process.env.R2_SECRET_ACCESS_KEY = 's';
process.env.R2_BUCKET_EPISODES = 'semente-episodios-prod';

const { pool, insertMessage } = await import('../../src/db.js');
const { registerReadRoutes } = await import('../../src/whatsapp/read-routes.js');
const { AuthzError } = await import('../../src/whatsapp/authz.js');

const TOKEN = 'tkn';
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };
const denyAuthz = {
  assertMember: async () => { throw new AuthzError('forbidden', 'FORBIDDEN'); },
  assertAdmin: async () => {},
};

function buildApp(authz: typeof passAuthz) {
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool, panelToken: TOKEN, authz });
  return app;
}

async function seedAudioMsg(mediaKey: string | null) {
  const m = await insertMessage({
    agent: null, channel: 'whatsapp', identifier: '+55a', direction: 'inbound', text: '[áudio]',
    evolution_event_id: 'E1', whatsapp_number_id: 1, workspace_id: 'ws-1',
    kind: 'audio', media_mime: 'audio/ogg', media_duration_s: 4, transcription_status: 'pending',
  });
  if (mediaKey) await pool.query(`UPDATE messages SET media_key=$2 WHERE id=$1`, [m.id, mediaKey]);
  return m.id;
}

beforeEach(async () => {
  await pool.query('TRUNCATE messages, whatsapp_numbers, whatsapp_access_log RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws-1','inst-1')`);
});
after(() => pool.end());

test('sem x-acting-user → 400', async () => {
  const id = await seedAudioMsg('k/1.ogg');
  const app = buildApp(passAuthz);
  const res = await app.inject({ method: 'GET', url: `/whatsapp/media/${id}`, headers: { 'x-panel-token': TOKEN } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('membro OK + media_key presente → 200 { url } + log media_presign', async () => {
  const id = await seedAudioMsg('k/1.ogg');
  const app = buildApp(passAuthz);
  const res = await app.inject({
    method: 'GET', url: `/whatsapp/media/${id}`,
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'u1' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schema, 'whatsapp_v1');
  assert.match(body.url, /X-Amz-Signature=/);
  assert.deepEqual(body.context, { workspaceId: 'ws-1', number: { id: 1, label: null, phone: null } });

  // logAccess é fire-and-forget: dá um tick pro INSERT assíncrono assentar.
  await new Promise(r => setImmediate(r));
  const { rows } = await pool.query(`SELECT actor, workspace_id, number_id FROM whatsapp_access_log WHERE action='media_presign'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, 'u1');
  assert.equal(rows[0].workspace_id, 'ws-1');
  assert.equal(Number(rows[0].number_id), 1);
  await app.close();
});

test('mensagem sem media_key → 404', async () => {
  const id = await seedAudioMsg(null);
  const app = buildApp(passAuthz);
  const res = await app.inject({
    method: 'GET', url: `/whatsapp/media/${id}`,
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'u1' },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('não-membro do workspace → 403', async () => {
  const id = await seedAudioMsg('k/1.ogg');
  const app = buildApp(denyAuthz);
  const res = await app.inject({
    method: 'GET', url: `/whatsapp/media/${id}`,
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'u2' },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});
