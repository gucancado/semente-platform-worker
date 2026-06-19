import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { createNumber, getNumberByInstance, updateNumberStatus, listNumbers } from '../../src/whatsapp/numbers.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('createNumber persiste e getNumberByInstance retorna a linha', async () => {
  const n = await createNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'ws-abc-xyz', label: 'Comercial', createdBy: 'u1' });
  assert.equal(n.status, 'pending');
  assert.equal(n.mode, 'monitored');
  const found = await getNumberByInstance(pool, 'ws-abc-xyz');
  assert.equal(found?.id, n.id);
  assert.equal(found?.workspaceId, 'ws-1');
});

test('updateNumberStatus muda status e phone por instance', async () => {
  await createNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'ws-abc-2', label: null, createdBy: null });
  await updateNumberStatus(pool, 'ws-abc-2', { status: 'connected', phone: '+5531999999999' });
  const found = await getNumberByInstance(pool, 'ws-abc-2');
  assert.equal(found?.status, 'connected');
  assert.equal(found?.phone, '+5531999999999');
  assert.deepEqual((await listNumbers(pool, 'ws-1')).map(x => x.evolutionInstance).sort(), ['ws-abc-2']);
});
