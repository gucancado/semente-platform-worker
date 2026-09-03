// tests/whatsapp/reconnect-links-routes.test.ts (server-gated: requer DATABASE_URL + Postgres real)
//
// Invariantes fixados aqui: a reconexão NUNCA cria nem deleta instância; token e
// tipo de rota casam nas duas direções; :instance só pode ser o do token (anti-IDOR).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerProvisionRoutes } from '../../src/whatsapp/provision-routes.js';
import type { EvolutionDeps } from '../../src/evolution/client.js';
import { createReconnectLink, createProvisionLink, getProvisionLink, generateLinkToken } from '../../src/whatsapp/provision-links.js';

function buildApp(state: 'open' | 'close' = 'close', opts: { webhookFails?: boolean; unknownInstance?: boolean } = {}) {
  const calls: string[] = [];
  const evolution: EvolutionDeps = {
    baseUrl: 'http://mock', apiKey: 'k',
    fetch: (async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (/\/instance\/connectionState\//.test(url)) {
        if (opts.unknownInstance) return { ok: false, status: 404, json: async () => ({}) } as any;
        return { ok: true, status: 200, json: async () => ({ instance: { state } }) } as any;
      }
      if (/\/webhook\/set\//.test(url) && opts.webhookFails) return { ok: false, status: 500, json: async () => ({}) } as any;
      if (/\/instance\/connect\//.test(url)) return { ok: true, status: 200, json: async () => ({ base64: 'data:image/png;base64,QR', pairingCode: 'ABCD1234' }) } as any;
      return { ok: true, status: 200, json: async () => ({}) } as any;
    }) as any,
  };
  const app = Fastify();
  registerProvisionRoutes(app, { pool, evolution, panelToken: 'test-panel', webhook: { url: 'https://wk/webhook', secret: 'sek' } });
  return { app, calls };
}
const H = { 'x-panel-token': 'test-panel', 'x-acting-user': 'u1' };

async function mkReconnect(instance = 'saturno', maxClicks = 10) {
  const token = generateLinkToken();
  await createReconnectLink(pool, {
    token, targetInstance: instance, targetLabel: 'Saturno', expectedPhone: '+553195950748',
    workspaceId: null, createdBy: null, maxClicks, ttlDays: 7,
  });
  return token;
}
async function mkProvision() {
  const token = generateLinkToken();
  await createProvisionLink(pool, { token, workspaceId: 'ws-1', createdBy: null, maxClicks: 10, ttlDays: 7 });
  return token;
}

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE whatsapp_provisioning');
  await pool.query('TRUNCATE whatsapp_provision_links');
});
after(() => pool.end());

// ── POST /link/:token/reconnect ──────────────────────────────────────────────

test('POST devolve a instância do token e consome 1 clique', async () => {
  const { app } = buildApp('close');
  const token = await mkReconnect();
  const res = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().instance, 'saturno');
  assert.equal((await getProvisionLink(pool, token))?.clicksUsed, 1);
});

test('POST NUNCA cria nem deleta instância na Evolution', async () => {
  const { app, calls } = buildApp('close');
  const token = await mkReconnect();
  await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H });
  assert.ok(!calls.some((c) => c.includes('/instance/create')), calls.join(' | '));
  assert.ok(!calls.some((c) => c.includes('/instance/delete')), calls.join(' | '));
});

test('POST com instância já open consome o link SEM gastar clique', async () => {
  const { app } = buildApp('open');
  const token = await mkReconnect();
  const res = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H });
  assert.equal(res.json().state, 'connected');
  const link = await getProvisionLink(pool, token);
  assert.equal(link?.status, 'consumed');
  assert.equal(link?.clicksUsed, 0);
});

test('POST cross-type (token de conexão nova) → 404', async () => {
  const { app } = buildApp('close');
  const res = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${await mkProvision()}/reconnect`, headers: H });
  assert.equal(res.statusCode, 404);
});

test('POST token inexistente → 404; exhausted → 409', async () => {
  const { app } = buildApp('close');
  const miss = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${generateLinkToken()}/reconnect`, headers: H });
  assert.equal(miss.statusCode, 404);
  const token = await mkReconnect('saturno', 1);
  await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H });
  const res = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().state, 'exhausted');
});

test('POST instância desconhecida na Evolution → 404 sem gastar clique', async () => {
  const { app } = buildApp('close', { unknownInstance: true });
  const token = await mkReconnect();
  const res = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H });
  assert.equal(res.statusCode, 404);
  assert.equal((await getProvisionLink(pool, token))?.clicksUsed, 0);
});

test('POST reembolsa o clique quando o set do webhook falha', async () => {
  const { app } = buildApp('close', { webhookFails: true });
  const token = await mkReconnect();
  const res = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H });
  assert.equal(res.statusCode, 502);
  assert.equal((await getProvisionLink(pool, token))?.clicksUsed, 0);
});

// ── GET /link/:token/reconnect/:instance ─────────────────────────────────────

test('GET serve QR em active E em exhausted (o 10º clique vale — paridade com o provisionamento)', async () => {
  const { app } = buildApp('close');
  const token = await mkReconnect('saturno', 1);
  await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/reconnect`, headers: H }); // vira exhausted
  const res = await app.inject({ method: 'GET', url: `/admin/whatsapp/link/${token}/reconnect/saturno`, headers: H });
  assert.equal(res.json().state, 'awaiting_scan');
  assert.ok(res.json().qr);
});

test('GET recusa expired e blocked; consumed vira connected', async () => {
  const { app } = buildApp('close');
  const token = await mkReconnect();
  await pool.query(`UPDATE whatsapp_provision_links SET status='blocked' WHERE token=$1`, [token]);
  assert.equal((await app.inject({ method: 'GET', url: `/admin/whatsapp/link/${token}/reconnect/saturno`, headers: H })).json().state, 'blocked');
  await pool.query(`UPDATE whatsapp_provision_links SET status='consumed' WHERE token=$1`, [token]);
  assert.equal((await app.inject({ method: 'GET', url: `/admin/whatsapp/link/${token}/reconnect/saturno`, headers: H })).json().state, 'connected');
  await pool.query(`UPDATE whatsapp_provision_links SET status='active', expires_at=NOW() - interval '1 hour' WHERE token=$1`, [token]);
  assert.equal((await app.inject({ method: 'GET', url: `/admin/whatsapp/link/${token}/reconnect/saturno`, headers: H })).json().state, 'expired');
});

test('GET com instância diferente do token → 404 (anti-IDOR)', async () => {
  const { app } = buildApp('close');
  const token = await mkReconnect('saturno');
  const res = await app.inject({ method: 'GET', url: `/admin/whatsapp/link/${token}/reconnect/ws-outra`, headers: H });
  assert.equal(res.statusCode, 404);
});

test('GET marca consumed quando a instância já conectou', async () => {
  const { app } = buildApp('open');
  const token = await mkReconnect();
  const res = await app.inject({ method: 'GET', url: `/admin/whatsapp/link/${token}/reconnect/saturno`, headers: H });
  assert.equal(res.json().state, 'connected');
  assert.equal((await getProvisionLink(pool, token))?.status, 'consumed');
});

test('GET estoura rate limit por token com 429', async () => {
  const { app } = buildApp('close');
  const token = await mkReconnect();
  let last = 0;
  for (let i = 0; i < 45; i++) {
    last = (await app.inject({ method: 'GET', url: `/admin/whatsapp/link/${token}/reconnect/saturno`, headers: H })).statusCode;
  }
  assert.equal(last, 429);
});

// ── guards no fluxo ANTIGO ───────────────────────────────────────────────────

test('POST/GET/DELETE do provisionamento recusam token de reconexão com 404 sem efeitos', async () => {
  const { app, calls } = buildApp('close');
  const token = await mkReconnect();
  const post = await app.inject({ method: 'POST', url: `/admin/whatsapp/link/${token}/provision`, headers: H });
  assert.equal(post.statusCode, 404);
  assert.equal((await getProvisionLink(pool, token))?.clicksUsed, 0); // guard vem ANTES do incremento
  const get = await app.inject({ method: 'GET', url: `/admin/whatsapp/link/${token}/provision/saturno`, headers: H });
  assert.equal(get.statusCode, 404);
  const del = await app.inject({ method: 'DELETE', url: `/admin/whatsapp/link/${token}/provision/saturno`, headers: H });
  assert.equal(del.statusCode, 404);
  assert.ok(!calls.some((c) => c.includes('/instance/delete')), calls.join(' | '));
});
