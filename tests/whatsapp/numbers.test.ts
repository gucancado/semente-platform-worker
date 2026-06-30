import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { createNumber, getNumberByInstance, updateNumberStatus, listNumbers, upsertConnectedNumber, renameNumberLabel } from '../../src/whatsapp/numbers.js';

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

test('upsertConnectedNumber insere connected + phone; idempotente por instância', async () => {
  const a = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'inst-x', phone: '+5531999', createdBy: 'u1' });
  assert.equal(a.status, 'connected');
  assert.equal(a.phone, '+5531999');
  assert.equal(a.label, null);
  // segundo evento open p/ a mesma instância não duplica
  const b = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'inst-x', phone: '+5531999', createdBy: 'u1' });
  assert.equal(b.id, a.id);
  const { rows } = await pool.query(`SELECT count(*)::int n FROM whatsapp_numbers WHERE evolution_instance='inst-x'`);
  assert.equal(rows[0].n, 1);
});

test('renameNumberLabel atualiza o label', async () => {
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'inst-y', phone: '+5531888', createdBy: null });
  await renameNumberLabel(pool, n.id, 'Comercial');
  const { rows } = await pool.query(`SELECT label FROM whatsapp_numbers WHERE id=$1`, [n.id]);
  assert.equal(rows[0].label, 'Comercial');
});

test('listNumbers esconde disconnected por default; includeDisconnected mostra', async () => {
  await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'inst-on', phone: '+551', createdBy: null });
  await pool.query(`INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, status) VALUES ('ws-1','inst-off','disconnected')`);
  const def = await listNumbers(pool, 'ws-1');
  assert.deepEqual(def.map((n) => n.evolutionInstance).sort(), ['inst-on']);
  const all = await listNumbers(pool, 'ws-1', { includeDisconnected: true });
  assert.equal(all.length, 2);
});
