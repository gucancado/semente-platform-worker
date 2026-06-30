import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { createProvisioning, getProvisioning } from '../../src/whatsapp/provisioning.js';
import { reapExpiredProvisioning } from '../../src/whatsapp/provisioning-reaper.js';
import type { EvolutionDeps } from '../../src/evolution/client.js';

beforeEach(async () => { await pool.query('TRUNCATE whatsapp_provisioning'); });
after(() => pool.end());

function evo(calls: string[]): EvolutionDeps {
  return { baseUrl: 'http://mock', apiKey: 'k', fetch: (async (url: string) => { calls.push(url); return { ok: true, status: 200, json: async () => ({}) } as any; }) as any };
}

test('reap remove staging vencido e chama Evolution; deixa o fresco', async () => {
  const calls: string[] = [];
  await createProvisioning(pool, { evolutionInstance: 'stale', workspaceId: 'ws-1', createdBy: null, ttlSeconds: -10 });
  await createProvisioning(pool, { evolutionInstance: 'fresh', workspaceId: 'ws-1', createdBy: null, ttlSeconds: 90 });
  const out = await reapExpiredProvisioning({ pool, evolution: evo(calls) });
  assert.equal(out.reaped, 1);
  assert.equal(await getProvisioning(pool, 'stale'), null);
  assert.ok(await getProvisioning(pool, 'fresh'));
  assert.ok(calls.some((u) => /\/instance\/delete\/stale$/.test(u)));
});

test('reap é resiliente a erro da Evolution (dropa staging mesmo assim)', async () => {
  const failing: EvolutionDeps = { baseUrl: 'http://mock', apiKey: 'k', fetch: (async () => { throw new Error('evolution down'); }) as any };
  await createProvisioning(pool, { evolutionInstance: 'stale2', workspaceId: 'ws-1', createdBy: null, ttlSeconds: -10 });
  const out = await reapExpiredProvisioning({ pool, evolution: failing });
  assert.equal(out.reaped, 1);
  assert.equal(await getProvisioning(pool, 'stale2'), null);
});
