import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerReadRoutes } from '../../src/whatsapp/read-routes.js';

const TOKEN = 'tkn';
function buildApp() { const app = Fastify(); registerReadRoutes(app, { pool, panelToken: TOKEN }); return app; }
beforeEach(async () => { await pool.query('TRUNCATE messages, whatsapp_numbers RESTART IDENTITY CASCADE'); });
after(() => pool.end());

test('GET /whatsapp/search agrupa por thread', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, identifier, direction, text, created_at) VALUES (1,'ws','c1','inbound','quero orçamento', NOW())`);
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/whatsapp/search?workspace_id=ws&number_id=1&query=orçamento', headers: { 'x-panel-token': TOKEN } });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).results[0].identifier, 'c1');
  await app.close();
});

test('GET /whatsapp/threads/:id/export devolve transcrição', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, identifier, direction, text, created_at) VALUES (1,'ws','+5531999','inbound','olá', NOW())`);
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/whatsapp/threads/%2B5531999/export?workspace_id=ws&number_id=1', headers: { 'x-panel-token': TOKEN } });
  assert.equal(res.statusCode, 200);
  assert.match(JSON.parse(res.body).transcript, /Cliente: olá/);
  await app.close();
});
