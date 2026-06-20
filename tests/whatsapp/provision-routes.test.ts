import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerProvisionRoutes } from '../../src/whatsapp/provision-routes.js';
import type { EvolutionDeps } from '../../src/evolution/client.js';

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
});
after(() => pool.end());

test('POST /admin/whatsapp/numbers cria a linha ANTES de chamar Evolution', async () => {
  const evolutionCalls: string[] = [];
  const app = buildApp(evolutionCalls);
  const res = await app.inject({ method: 'POST', url: '/admin/whatsapp/numbers',
    headers: { 'x-panel-token': 'test-panel', 'x-acting-user': 'u1' },
    payload: { workspace_id: 'ws-1', label: 'Comercial' } });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.match(body.evolution_instance, /^ws-/);
  const { rows } = await pool.query(`SELECT status FROM whatsapp_numbers WHERE evolution_instance=$1`, [body.evolution_instance]);
  assert.equal(rows[0].status, 'connecting');
  assert.ok(evolutionCalls.includes(`create:${body.evolution_instance}`));
  // webhook por-instância registrado com o secret (senão o /webhook do worker 401-rejeita o global)
  assert.ok(evolutionCalls.includes(`webhook:${body.evolution_instance}:sek`));
});

test('rejeita sem X-Panel-Token', async () => {
  const app = buildApp([]);
  const res = await app.inject({ method: 'POST', url: '/admin/whatsapp/numbers', payload: { workspace_id: 'ws-1' } });
  assert.equal(res.statusCode, 401);
});

test('rejeita workspace_id ausente (guard P2.10)', async () => {
  const app = buildApp([]);
  const res = await app.inject({ method: 'POST', url: '/admin/whatsapp/numbers',
    headers: { 'x-panel-token': 'test-panel' }, payload: { label: 'x' } });
  assert.equal(res.statusCode, 400);
});
