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

const PANEL_TOKEN = 'test-panel';
const MEMBER = 'u1';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, messages, whatsapp_thread_meta RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('GET /whatsapp/numbers escopa por workspace_id e carrega schema', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, label) VALUES ('ws-1','i','Com')`);
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/whatsapp/numbers?workspace_id=ws-1', headers: { 'x-panel-token': PANEL_TOKEN, 'x-acting-user': MEMBER } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().schema, 'whatsapp_v1');
  assert.equal(res.json().numbers.length, 1);
});

test('GET /whatsapp/numbers rejeita sem X-Panel-Token', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/whatsapp/numbers?workspace_id=ws-1' });
  assert.equal(res.statusCode, 401);
});

test('GET /whatsapp/threads?temperature=quente filtra por lead_temperature', async () => {
  const ws = 'ws-temp';
  // Insere 1 número no workspace
  await pool.query(
    `INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, label) VALUES ($1, 'inst-temp', 'Temp')`,
    [ws],
  );
  const { rows: [{ id: numberId }] } = await pool.query<{ id: number }>(
    `SELECT id FROM whatsapp_numbers WHERE evolution_instance = 'inst-temp'`,
  );

  // Thread quente: 1 mensagem + row em thread_meta com lead_temperature='quente'
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
     VALUES ($1, $2, 'whatsapp', '+quente', 'inbound', 'ola quente', NOW())`,
    [numberId, ws],
  );
  await pool.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, lead_temperature)
     VALUES ($1, '+quente', 'quente')`,
    [numberId],
  );

  // Thread sem meta (não deve aparecer quando filtro está setado)
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
     VALUES ($1, $2, 'whatsapp', '+frio', 'inbound', 'ola frio', NOW())`,
    [numberId, ws],
  );

  const app = buildApp();
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/threads?workspace_id=${ws}&number_id=${numberId}&temperature=quente`,
    headers: { 'x-panel-token': PANEL_TOKEN, 'x-acting-user': MEMBER },
  });
  assert.equal(res.statusCode, 200);
  const ids = res.json().threads.map((t: any) => t.identifier);
  assert.deepEqual(ids, ['+quente']);
});
