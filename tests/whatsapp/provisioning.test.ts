import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { createProvisioning, getProvisioning, deleteProvisioning, listExpiredProvisioning } from '../../src/whatsapp/provisioning.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_provisioning');
});
after(() => pool.end());

test('create + get devolve a linha de staging', async () => {
  const row = await createProvisioning(pool, { evolutionInstance: 'inst-1', workspaceId: 'ws-1', createdBy: 'u1', ttlSeconds: 90 });
  assert.equal(row.evolutionInstance, 'inst-1');
  assert.equal(row.workspaceId, 'ws-1');
  const got = await getProvisioning(pool, 'inst-1');
  assert.equal(got?.workspaceId, 'ws-1');
  assert.equal(await getProvisioning(pool, 'ghost'), null);
});

test('delete remove a linha (idempotente)', async () => {
  await createProvisioning(pool, { evolutionInstance: 'inst-2', workspaceId: 'ws-1', createdBy: null, ttlSeconds: 90 });
  await deleteProvisioning(pool, 'inst-2');
  assert.equal(await getProvisioning(pool, 'inst-2'), null);
  await deleteProvisioning(pool, 'inst-2'); // no-op, não lança
});

test('listExpired devolve só os vencidos', async () => {
  await createProvisioning(pool, { evolutionInstance: 'fresh', workspaceId: 'ws-1', createdBy: null, ttlSeconds: 90 });
  await createProvisioning(pool, { evolutionInstance: 'stale', workspaceId: 'ws-1', createdBy: null, ttlSeconds: -10 });
  const expired = await listExpiredProvisioning(pool, 100);
  assert.deepEqual(expired.map((r) => r.evolutionInstance), ['stale']);
});
