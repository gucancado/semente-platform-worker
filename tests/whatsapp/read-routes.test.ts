import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerReadRoutes } from '../../src/whatsapp/read-routes.js';

// authz fake que passa: este teste valida o contrato de LEITURA (numbers), não a
// authz (testada em read-routes.authz.test.ts). Sem injetar, a authz real
// chamaria o Bloquim e fail-closaria (403).
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };
function buildApp() {
  const app = Fastify();
  registerReadRoutes(app, { pool, panelToken: 'test-panel', authz: passAuthz });
  return app;
}

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, messages RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('GET /whatsapp/numbers escopa por workspace_id e carrega schema', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, label) VALUES ('ws-1','i','Com')`);
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/whatsapp/numbers?workspace_id=ws-1', headers: { 'x-panel-token': 'test-panel', 'x-acting-user': 'u1' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().schema, 'whatsapp_v1');
  assert.equal(res.json().numbers.length, 1);
});

test('GET /whatsapp/numbers rejeita sem X-Panel-Token', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/whatsapp/numbers?workspace_id=ws-1' });
  assert.equal(res.statusCode, 401);
});
