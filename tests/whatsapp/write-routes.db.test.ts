// tests/whatsapp/write-routes.db.test.ts  (roda no servidor com DATABASE_URL)
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerWriteRoutes } from '../../src/whatsapp/write-routes.js';

const TOKEN = 'tkn';
function buildApp() { const app = Fastify(); registerWriteRoutes(app, { pool, panelToken: TOKEN }); return app; }

beforeEach(async () => { await pool.query('TRUNCATE whatsapp_numbers, whatsapp_thread_meta RESTART IDENTITY CASCADE'); });
after(() => pool.end());

test('POST lead grava not_lead com X-Panel-Token', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: '/whatsapp/threads/c1/lead', headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'u1' }, payload: { number_id: 1, status: 'not_lead' } });
  assert.equal(res.statusCode, 200);
  const r = await pool.query(`SELECT is_lead, updated_by FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier='c1'`);
  assert.equal(r.rows[0].is_lead, false);
  assert.equal(r.rows[0].updated_by, 'u1');
  await app.close();
});

test('401 sem token', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: '/whatsapp/threads/c1/lead', payload: { number_id: 1, status: 'lead' } });
  assert.equal(res.statusCode, 401);
  await app.close();
});
