import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { updateNumberStatus, upsertConnectedNumber } from '../../src/whatsapp/numbers.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('connected → disconnected seta disconnected_since e devolve a transição', async () => {
  await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'i-1', phone: '+5531999', createdBy: null });
  const t = await updateNumberStatus(pool, 'i-1', { status: 'disconnected' });
  assert.ok(t);
  assert.equal(t.oldStatus, 'connected');
  assert.equal(t.newStatus, 'disconnected');
  assert.equal(t.workspaceId, 'ws-1');
  assert.equal(t.wasAlerted, false);
  const { rows } = await pool.query(`SELECT disconnected_since, alerted_at FROM whatsapp_numbers WHERE evolution_instance='i-1'`);
  assert.notEqual(rows[0].disconnected_since, null);
  assert.equal(rows[0].alerted_at, null);
});

test('disconnected → connecting NÃO reinicia disconnected_since (mantém o original)', async () => {
  await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'i-1', phone: '+5531999', createdBy: null });
  await updateNumberStatus(pool, 'i-1', { status: 'disconnected' });
  const first = (await pool.query(`SELECT disconnected_since FROM whatsapp_numbers WHERE evolution_instance='i-1'`)).rows[0].disconnected_since;
  await updateNumberStatus(pool, 'i-1', { status: 'connecting' });
  const second = (await pool.query(`SELECT disconnected_since FROM whatsapp_numbers WHERE evolution_instance='i-1'`)).rows[0].disconnected_since;
  assert.deepEqual(second, first);
});

test('reconexão (→ connected) zera disconnected_since/alerted_at e reporta wasAlerted', async () => {
  await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'i-1', phone: '+5531999', createdBy: null });
  await updateNumberStatus(pool, 'i-1', { status: 'disconnected' });
  await pool.query(`UPDATE whatsapp_numbers SET alerted_at = NOW() WHERE evolution_instance='i-1'`);
  const t = await updateNumberStatus(pool, 'i-1', { status: 'connected' });
  assert.ok(t);
  assert.equal(t.newStatus, 'connected');
  assert.equal(t.wasAlerted, true);
  const { rows } = await pool.query(`SELECT disconnected_since, alerted_at FROM whatsapp_numbers WHERE evolution_instance='i-1'`);
  assert.equal(rows[0].disconnected_since, null);
  assert.equal(rows[0].alerted_at, null);
});

test('instância inexistente → null', async () => {
  assert.equal(await updateNumberStatus(pool, 'ghost', { status: 'disconnected' }), null);
});
