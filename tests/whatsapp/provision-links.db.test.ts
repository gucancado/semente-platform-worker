// tests/whatsapp/provision-links.db.test.ts (server-gated: requer DATABASE_URL + Postgres real)
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { createProvisionLink, getProvisionLink, incrementLinkClick, markLinkConsumed, generateLinkToken } from '../../src/whatsapp/provision-links.js';

beforeEach(async () => { await pool.query('TRUNCATE whatsapp_provision_links'); });
after(() => pool.end());

test('create + get; expires_at ~ now + 7d', async () => {
  const token = generateLinkToken();
  const link = await createProvisionLink(pool, { token, workspaceId: 'ws-1', createdBy: 'u1', maxClicks: 10, ttlDays: 7 });
  assert.equal(link.workspaceId, 'ws-1');
  assert.equal(link.clicksUsed, 0);
  const got = await getProvisionLink(pool, token);
  assert.equal(got?.status, 'active');
  const days = (new Date(got!.expiresAt).getTime() - new Date(got!.createdAt).getTime()) / 86400000;
  assert.ok(Math.abs(days - 7) < 0.01);
});

test('incrementLinkClick incrementa e marca exhausted no 10º; recusa o 11º', async () => {
  const token = generateLinkToken();
  await createProvisionLink(pool, { token, workspaceId: 'ws-1', createdBy: null, maxClicks: 10, ttlDays: 7 });
  for (let i = 0; i < 10; i++) {
    const r = await incrementLinkClick(pool, token);
    assert.equal(r.ok, true);
  }
  assert.equal((await getProvisionLink(pool, token))?.status, 'exhausted');
  const r11 = await incrementLinkClick(pool, token);
  assert.deepEqual(r11, { ok: false, state: 'exhausted' });
});

test('markLinkConsumed marca consumed + connected_number_id; idempotente', async () => {
  const token = generateLinkToken();
  await createProvisionLink(pool, { token, workspaceId: 'ws-1', createdBy: null, maxClicks: 10, ttlDays: 7 });
  await markLinkConsumed(pool, token, 42);
  const got = await getProvisionLink(pool, token);
  assert.equal(got?.status, 'consumed');
  assert.equal(got?.connectedNumberId, 42);
  await markLinkConsumed(pool, token, 99); // no-op
  assert.equal((await getProvisionLink(pool, token))?.connectedNumberId, 42);
});

test('incrementLinkClick recusa quando já consumed', async () => {
  const token = generateLinkToken();
  await createProvisionLink(pool, { token, workspaceId: 'ws-1', createdBy: null, maxClicks: 10, ttlDays: 7 });
  await markLinkConsumed(pool, token, 1);
  assert.deepEqual(await incrementLinkClick(pool, token), { ok: false, state: 'consumed' });
});
