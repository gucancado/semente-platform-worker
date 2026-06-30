import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerProvisionRoutes } from '../../src/whatsapp/provision-routes.js';
import type { EvolutionDeps } from '../../src/evolution/client.js';
import { createProvisioning } from '../../src/whatsapp/provisioning.js';
import { upsertConnectedNumber } from '../../src/whatsapp/numbers.js';

function buildApp(evolutionCalls: string[]) {
  const app = Fastify();
  const evolution: EvolutionDeps = {
    baseUrl: 'http://mock', apiKey: 'k',
    fetch: (async (url: string, init: any) => {
      if (/\/instance\/create$/.test(url)) evolutionCalls.push(`create:${JSON.parse(init.body).instanceName}`);
      const m = url.match(/\/webhook\/set\/(.+)$/);
      if (m) {
        const hdr = JSON.parse(init.body).webhook?.headers?.['X-Evolution-Secret'];
        evolutionCalls.push(`webhook:${m[1]}:${hdr}`);
      }
      return { ok: true, status: 200, json: async () => ({}) } as any;
    }) as any,
  };
  registerProvisionRoutes(app, { pool, evolution, panelToken: 'test-panel', webhook: { url: 'https://wk/webhook', secret: 'sek' } });
  return app;
}

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE whatsapp_provisioning');
});
after(() => pool.end());

test('rejeita sem X-Panel-Token', async () => {
  const app = buildApp([]);
  const res = await app.inject({ method: 'POST', url: '/admin/whatsapp/numbers', payload: { workspace_id: 'ws-1' } });
  assert.equal(res.statusCode, 401);
});

test('POST /provision cria staging + Evolution, NÃO toca whatsapp_numbers', async () => {
  const calls: string[] = [];
  const app = buildApp(calls);
  const res = await app.inject({ method: 'POST', url: '/admin/whatsapp/provision',
    headers: { 'x-panel-token': 'test-panel', 'x-acting-user': 'u1' },
    payload: { workspace_id: 'ws-1' } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.match(body.instance, /^ws-/);
  assert.ok(body.expiresAt);
  const prov = await pool.query(`SELECT workspace_id FROM whatsapp_provisioning WHERE evolution_instance=$1`, [body.instance]);
  assert.equal(prov.rows[0].workspace_id, 'ws-1');
  const nums = await pool.query(`SELECT count(*)::int n FROM whatsapp_numbers`);
  assert.equal(nums.rows[0].n, 0);
  assert.ok(calls.includes(`create:${body.instance}`));
  assert.ok(calls.includes(`webhook:${body.instance}:sek`));
});

test('GET /provision/:instance = awaiting_scan com qr enquanto staging válido', async () => {
  const app = buildApp([]);
  await createProvisioning(pool, { evolutionInstance: 'inst-a', workspaceId: 'ws-1', createdBy: null, ttlSeconds: 90 });
  const res = await app.inject({ method: 'GET', url: '/admin/whatsapp/provision/inst-a?workspace_id=ws-1',
    headers: { 'x-panel-token': 'test-panel' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().state, 'awaiting_scan');
});

test('GET /provision/:instance = connected após commit', async () => {
  const app = buildApp([]);
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'inst-b', phone: '+5531999', createdBy: null });
  const res = await app.inject({ method: 'GET', url: '/admin/whatsapp/provision/inst-b?workspace_id=ws-1',
    headers: { 'x-panel-token': 'test-panel' } });
  const body = res.json();
  assert.equal(body.state, 'connected');
  assert.equal(body.numberId, n.id);
  assert.equal(body.phone, '+5531999');
});

test('GET /provision/:instance rejeita workspace de outro tenant', async () => {
  const app = buildApp([]);
  await createProvisioning(pool, { evolutionInstance: 'inst-c', workspaceId: 'ws-OWNER', createdBy: null, ttlSeconds: 90 });
  const res = await app.inject({ method: 'GET', url: '/admin/whatsapp/provision/inst-c?workspace_id=ws-OTHER',
    headers: { 'x-panel-token': 'test-panel' } });
  assert.equal(res.statusCode, 404);
});

test('DELETE /provision/:instance dropa staging + chama Evolution (idempotente)', async () => {
  const calls: string[] = [];
  const app = buildApp(calls);
  await createProvisioning(pool, { evolutionInstance: 'inst-d', workspaceId: 'ws-1', createdBy: null, ttlSeconds: 90 });
  const res = await app.inject({ method: 'DELETE', url: '/admin/whatsapp/provision/inst-d',
    headers: { 'x-panel-token': 'test-panel' } });
  assert.equal(res.statusCode, 200);
  const prov = await pool.query(`SELECT 1 FROM whatsapp_provisioning WHERE evolution_instance='inst-d'`);
  assert.equal(prov.rows.length, 0);
});

test('PATCH /numbers/:id/label vazio → label vira o telefone', async () => {
  const app = buildApp([]);
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'inst-e', phone: '+5531222', createdBy: null });
  const res = await app.inject({ method: 'PATCH', url: `/admin/whatsapp/numbers/${n.id}/label`,
    headers: { 'x-panel-token': 'test-panel' }, payload: { label: '   ' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().label, '+5531222');
});

test('PATCH /numbers/:id/label preenchido → trim', async () => {
  const app = buildApp([]);
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'inst-f', phone: '+5531222', createdBy: null });
  const res = await app.inject({ method: 'PATCH', url: `/admin/whatsapp/numbers/${n.id}/label`,
    headers: { 'x-panel-token': 'test-panel' }, payload: { label: '  Vendas ' } });
  assert.equal(res.json().label, 'Vendas');
});

test('POST /numbers (antigo) responde 410', async () => {
  const app = buildApp([]);
  const res = await app.inject({ method: 'POST', url: '/admin/whatsapp/numbers',
    headers: { 'x-panel-token': 'test-panel' }, payload: { workspace_id: 'ws-1' } });
  assert.equal(res.statusCode, 410);
});
