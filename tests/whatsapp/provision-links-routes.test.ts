import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerProvisionRoutes } from '../../src/whatsapp/provision-routes.js';
import type { EvolutionDeps } from '../../src/evolution/client.js';
import { createProvisionLink, getProvisionLink, generateLinkToken } from '../../src/whatsapp/provision-links.js';

function buildApp() {
  const app = Fastify();
  const evolution: EvolutionDeps = {
    baseUrl: 'http://mock', apiKey: 'k',
    fetch: (async (url: string) => {
      if (/\/instance\/connect\//.test(url)) return { ok: true, status: 200, json: async () => ({ base64: 'data:image/png;base64,QR', pairingCode: 'ABCD' }) } as any;
      return { ok: true, status: 200, json: async () => ({}) } as any;
    }) as any,
  };
  registerProvisionRoutes(app, { pool, evolution, panelToken: 'test-panel', webhook: { url: 'https://wk/webhook', secret: 'sek' } });
  return app;
}
const H = { 'x-panel-token': 'test-panel', 'x-acting-user': 'u1' };

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE whatsapp_provisioning');
  await pool.query('TRUNCATE whatsapp_provision_links');
});
after(() => pool.end());

test('POST /provision-links cria link e GET reflete active', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: '/admin/whatsapp/provision-links', headers: H, payload: { workspace_id: 'ws-1' } });
  assert.equal(res.statusCode, 200);
  const { token, maxClicks } = res.json();
  assert.equal(maxClicks, 10);
  const get = await app.inject({ method: 'GET', url: `/admin/whatsapp/provision-links/${token}`, headers: H });
  assert.equal(get.json().status, 'active');
  assert.equal(get.json().workspaceId, 'ws-1');
});

test('POST /link/:token/provision consome clique e cria staging', async () => {
  const app = buildApp();
  const token = generateLinkToken();
  await createProvisionLink(pool, { token, workspaceId: 'ws-1', createdBy: null, maxClicks: 10, ttlDays: 7 });
  const res = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/provision`, headers: H });
  assert.equal(res.statusCode, 200);
  assert.match(res.json().instance, /^ws-/);
  assert.equal((await getProvisionLink(pool, token))?.clicksUsed, 1);
});

test('POST /link/:token/provision → 409 quando exhausted', async () => {
  const app = buildApp();
  const token = generateLinkToken();
  await createProvisionLink(pool, { token, workspaceId: 'ws-1', createdBy: null, maxClicks: 1, ttlDays: 7 });
  await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/provision`, headers: H }); // consome o único
  const res = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/provision`, headers: H });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().state, 'exhausted');
});

test('GET /link/:token/provision/:instance = awaiting_scan com QR', async () => {
  const app = buildApp();
  const token = generateLinkToken();
  await createProvisionLink(pool, { token, workspaceId: 'ws-1', createdBy: null, maxClicks: 10, ttlDays: 7 });
  const prov = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/provision`, headers: H });
  const instance = prov.json().instance;
  const st = await app.inject({ method: 'GET', url: `/admin/whatsapp/link/${token}/provision/${instance}`, headers: H });
  assert.equal(st.json().state, 'awaiting_scan');
  assert.ok(st.json().qr);
});

test('rotas de link exigem panel token', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: '/admin/whatsapp/provision-links', payload: { workspace_id: 'ws-1' } });
  assert.equal(res.statusCode, 401);
});
