import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerWriteRoutes } from '../../src/whatsapp/write-routes.js';

const TOKEN = 'tkn';
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };
function buildApp() {
  const app = Fastify();
  registerWriteRoutes(app, { pool, panelToken: TOKEN, authz: passAuthz });
  return app;
}

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, whatsapp_thread_meta RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
});
after(() => pool.end());

for (const [field, value] of [
  ['stage', 'qualificado'],
  ['temperature', 'quente'],
  ['tags', ['vip']],
] as const) {
  test(`single: ${field} é descontinuado`, async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/whatsapp/threads/c1/lead',
      headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'u1' },
      payload: { number_id: 1, status: 'lead', [field]: value },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'campo descontinuado: use as rotas/tools de oportunidades');
    await app.close();
  });
}

test('single: sem status retorna 400', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/c3/lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'u1' },
    payload: { number_id: 1, notes: 'triagem' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /status/);
  await app.close();
});

test('single: status explícito continua valendo', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/c4/lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'u1' },
    payload: { number_id: 1, status: 'not_lead' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().leadStatus, 'not_lead');
  await app.close();
});

test('bulk: item com stage é descontinuado', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'u1' },
    payload: { number_id: 1, updates: [{ identifier: 'c5', status: 'lead', stage: 'desqualificado' }] },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /stage/);
  await app.close();
});
