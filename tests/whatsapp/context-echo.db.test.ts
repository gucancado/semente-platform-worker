import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerReadRoutes } from '../../src/whatsapp/read-routes.js';
import { registerWriteRoutes } from '../../src/whatsapp/write-routes.js';
import { registerProvisionRoutes } from '../../src/whatsapp/provision-routes.js';

const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };
function buildApp() {
  const app = Fastify();
  registerReadRoutes(app, { pool, panelToken: 'test-panel', authz: passAuthz });
  return app;
}
const H = { 'x-panel-token': 'test-panel', 'x-acting-user': 'u1' };

async function seedNumber(ws: string, instance: string, label: string | null, phone: string | null) {
  await pool.query(
    `INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, label, phone, status) VALUES ($1,$2,$3,$4,'connected')`,
    [ws, instance, label, phone],
  );
  const { rows: [{ id }] } = await pool.query<{ id: string }>(`SELECT id FROM whatsapp_numbers WHERE evolution_instance = $1`, [instance]);
  return Number(id); // whatsapp_numbers.id é bigint → pg devolve string; a resposta ecoa number (getNumber faz Number(r.id))
}

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, messages, whatsapp_thread_meta RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('/whatsapp/numbers ecoa context workspace-only (number null)', async () => {
  await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  const res = await buildApp().inject({ method: 'GET', url: '/whatsapp/numbers?workspace_id=ws-1', headers: H });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: null });
});

test('/whatsapp/threads ecoa context com number {id,label,phone}', async () => {
  const id = await seedNumber('ws-1', 'i1', 'Comercial SP', '+5511900000001');
  const res = await buildApp().inject({ method: 'GET', url: `/whatsapp/threads?workspace_id=ws-1&number_id=${id}`, headers: H });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: { id, label: 'Comercial SP', phone: '+5511900000001' } });
});

test('/whatsapp/threads: number de OUTRO workspace → number null (anti-leak)', async () => {
  await seedNumber('ws-1', 'i1', 'A', '+5511900000001');
  const idB = await seedNumber('ws-2', 'i2', 'SecretoB', '+5511900000002');
  // membro de ws-1 passa number_id de ws-2 (gate fake passa; SQL filtra vazio)
  const res = await buildApp().inject({ method: 'GET', url: `/whatsapp/threads?workspace_id=ws-1&number_id=${idB}`, headers: H });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: null });
  assert.deepEqual(res.json().threads, []);
});

test('/whatsapp/search ecoa context com number', async () => {
  const id = await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  const res = await buildApp().inject({ method: 'GET', url: `/whatsapp/search?workspace_id=ws-1&number_id=${id}&query=oi`, headers: H });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: { id, label: 'Com', phone: '+5511900000001' } });
});

test('/whatsapp/stats sem number_id → context workspace-only', async () => {
  await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  const res = await buildApp().inject({ method: 'GET', url: '/whatsapp/stats?workspace_id=ws-1', headers: H });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: null });
});

test('/whatsapp/stats com number_id → context com number', async () => {
  const id = await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  const res = await buildApp().inject({ method: 'GET', url: `/whatsapp/stats?workspace_id=ws-1&number_id=${id}`, headers: H });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: { id, label: 'Com', phone: '+5511900000001' } });
});

test('/whatsapp/threads/:id/messages ecoa context derivado do number', async () => {
  const id = await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
     VALUES ($1,'ws-1','whatsapp','+5511988887777','inbound','oi', NOW())`, [id]);
  const res = await buildApp().inject({ method: 'GET', url: `/whatsapp/threads/${encodeURIComponent('+5511988887777')}/messages?number_id=${id}`, headers: H });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: { id, label: 'Com', phone: '+5511900000001' } });
});

test('erro 400 (number_id não-numérico) NÃO carrega context', async () => {
  const res = await buildApp().inject({ method: 'GET', url: '/whatsapp/threads?workspace_id=ws-1&number_id=abc', headers: H });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().context, undefined);
});

test('/whatsapp/disqualify-reasons e /source-signals ecoam context workspace-only', async () => {
  await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  const dr = await buildApp().inject({ method: 'GET', url: '/whatsapp/disqualify-reasons?workspace_id=ws-1', headers: H });
  assert.deepEqual(dr.json().context, { workspaceId: 'ws-1', number: null });
  const ss = await buildApp().inject({ method: 'GET', url: '/whatsapp/source-signals?workspace_id=ws-1', headers: H });
  assert.deepEqual(ss.json().context, { workspaceId: 'ws-1', number: null });
});

function buildWriteApp() {
  const app = Fastify();
  registerWriteRoutes(app, { pool, panelToken: 'test-panel', authz: passAuthz });
  return app;
}

test('POST /whatsapp/threads/:id/lead ecoa context derivado do number', async () => {
  const id = await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
     VALUES ($1,'ws-1','whatsapp','+5511988887777','inbound','oi', NOW())`, [id]);
  const res = await buildWriteApp().inject({
    method: 'POST', url: `/whatsapp/threads/${encodeURIComponent('+5511988887777')}/lead`,
    headers: { ...H, 'content-type': 'application/json' },
    payload: { number_id: id, status: 'lead' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: { id, label: 'Com', phone: '+5511900000001' } });
  assert.equal(res.json().ok, true);
});

test('POST /whatsapp/threads/bulk-lead ecoa context derivado do number', async () => {
  const id = await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
     VALUES ($1,'ws-1','whatsapp','+5511988887777','inbound','oi', NOW())`, [id]);
  const res = await buildWriteApp().inject({
    method: 'POST', url: '/whatsapp/threads/bulk-lead',
    headers: { ...H, 'content-type': 'application/json' },
    payload: { number_id: id, updates: [{ identifier: '+5511988887777', status: 'lead' }] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: { id, label: 'Com', phone: '+5511900000001' } });
});

function buildProvisionApp() {
  const app = Fastify();
  registerProvisionRoutes(app, {
    pool,
    evolution: {} as any,           // group-exposure não usa evolution
    panelToken: 'test-panel',
    webhook: { url: 'http://x', secret: 's' },
  });
  return app;
}

test('POST /admin/whatsapp/numbers/:id/group-exposure ecoa context', async () => {
  const id = await seedNumber('ws-1', 'i1', 'Com', '+5511900000001');
  const res = await buildProvisionApp().inject({
    method: 'POST', url: `/admin/whatsapp/numbers/${id}/group-exposure`,
    headers: { 'x-panel-token': 'test-panel', 'content-type': 'application/json' },
    payload: { expose: true },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().context, { workspaceId: 'ws-1', number: { id, label: 'Com', phone: '+5511900000001' } });
  assert.equal(res.json().expose_groups_in_mcp, true);
});
