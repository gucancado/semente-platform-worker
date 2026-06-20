import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { acquireChannelLock, releaseChannelLock } from '../../src/whatsapp/channel-lock.js';

beforeEach(async () => {
  await pool.query('TRUNCATE channel_locks, whatsapp_numbers RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('segundo agente não adquire lock válido; adquire após release', async () => {
  const { rows } = await pool.query(`INSERT INTO whatsapp_numbers (workspace_id, evolution_instance) VALUES ('ws-1','i') RETURNING id`);
  const numberId = Number(rows[0].id);
  assert.equal(await acquireChannelLock(pool, { numberId, identifier: '+55', agent: 'mercurio', ttlSeconds: 120 }), true);
  assert.equal(await acquireChannelLock(pool, { numberId, identifier: '+55', agent: 'saturno', ttlSeconds: 120 }), false);
  await releaseChannelLock(pool, { numberId, identifier: '+55', agent: 'mercurio' });
  assert.equal(await acquireChannelLock(pool, { numberId, identifier: '+55', agent: 'saturno', ttlSeconds: 120 }), true);
});

test('lock expirado é roubável', async () => {
  const { rows } = await pool.query(`INSERT INTO whatsapp_numbers (workspace_id, evolution_instance) VALUES ('ws-1','j') RETURNING id`);
  const numberId = Number(rows[0].id);
  await acquireChannelLock(pool, { numberId, identifier: '+55', agent: 'mercurio', ttlSeconds: -1 }); // já expirado
  assert.equal(await acquireChannelLock(pool, { numberId, identifier: '+55', agent: 'saturno', ttlSeconds: 120 }), true);
});
