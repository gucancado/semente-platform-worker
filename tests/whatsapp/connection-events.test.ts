import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { handleConnectionEvent } from '../../src/whatsapp/connection-events.js';
import { createProvisioning, getProvisioning } from '../../src/whatsapp/provisioning.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE whatsapp_provisioning');
});
after(() => pool.end());

test('connection.update open marca connected + phone; é no-op se instância desconhecida', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, status) VALUES ('ws-1','inst-1','connecting')`);
  const handled = await handleConnectionEvent(pool, { event: 'connection.update', instance: 'inst-1', data: { state: 'open', wuid: '5531999@s.whatsapp.net' } });
  assert.equal(handled, true);
  const { rows } = await pool.query(`SELECT status, phone FROM whatsapp_numbers WHERE evolution_instance='inst-1'`);
  assert.equal(rows[0].status, 'connected');
  assert.equal(rows[0].phone, '+5531999');
  // instância desconhecida: tratado (true) mas sem erro
  assert.equal(await handleConnectionEvent(pool, { event: 'connection.update', instance: 'ghost', data: { state: 'open' } }), true);
});

test('messages.upsert não é evento de instância → retorna false', async () => {
  assert.equal(await handleConnectionEvent(pool, { event: 'messages.upsert', instance: 'inst-1', data: {} }), false);
});

test('open com staging (sem número) COMMITA: cria número connected e dropa staging', async () => {
  await createProvisioning(pool, { evolutionInstance: 'prov-1', workspaceId: 'ws-9', createdBy: 'u1', ttlSeconds: 90 });
  const handled = await handleConnectionEvent(pool, { event: 'connection.update', instance: 'prov-1', data: { state: 'open', wuid: '5531777@s.whatsapp.net' } });
  assert.equal(handled, true);
  const { rows } = await pool.query(`SELECT workspace_id, status, phone, label FROM whatsapp_numbers WHERE evolution_instance='prov-1'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workspace_id, 'ws-9');
  assert.equal(rows[0].status, 'connected');
  assert.equal(rows[0].phone, '+5531777');
  assert.equal(rows[0].label, null);
  assert.equal(await getProvisioning(pool, 'prov-1'), null); // staging consumido
});

test('open SEM staging e SEM número = no-op (não cria nada)', async () => {
  const handled = await handleConnectionEvent(pool, { event: 'connection.update', instance: 'ghost', data: { state: 'open', wuid: '551@s.whatsapp.net' } });
  assert.equal(handled, true);
  const { rows } = await pool.query(`SELECT count(*)::int n FROM whatsapp_numbers`);
  assert.equal(rows[0].n, 0);
});
