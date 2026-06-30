import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { handleConnectionEvent } from '../../src/whatsapp/connection-events.js';
import { createProvisioning, getProvisioning } from '../../src/whatsapp/provisioning.js';
import { upsertConnectedNumber, setNumberLifecycle } from '../../src/whatsapp/numbers.js';

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

test('staging open revive ficha removida de mesmo telefone+workspace (histórico volta)', async () => {
  const old = await upsertConnectedNumber(pool, { workspaceId: 'ws-9', evolutionInstance: 'old-i', phone: '+5531777', createdBy: 'u1' });
  // histórico atrelado ao number_id antigo
  await pool.query(`INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier) VALUES ($1,'+5531000')`, [old.id]);
  await setNumberLifecycle(pool, old.id, { status: 'disconnected', removed: true });
  // novo onboarding (instância nova) do mesmo telefone
  await createProvisioning(pool, { evolutionInstance: 'new-i', workspaceId: 'ws-9', createdBy: 'u1', ttlSeconds: 90 });
  await handleConnectionEvent(pool, { event: 'connection.update', instance: 'new-i', data: { state: 'open', wuid: '5531777@s.whatsapp.net' } });

  const { rows } = await pool.query(`SELECT id, status, removed_at, evolution_instance FROM whatsapp_numbers WHERE workspace_id='ws-9'`);
  assert.equal(rows.length, 1);          // não duplicou ficha
  assert.equal(Number(rows[0].id), old.id); // mesma ficha → histórico acessível
  assert.equal(rows[0].status, 'connected');
  assert.equal(rows[0].removed_at, null);
  assert.equal(rows[0].evolution_instance, 'new-i');
  const meta = await pool.query(`SELECT count(*)::int n FROM whatsapp_thread_meta WHERE whatsapp_number_id=$1`, [old.id]);
  assert.equal(meta.rows[0].n, 1);        // histórico segue atrelado
});

test('mesmo telefone em outro workspace NÃO herda histórico (ficha nova)', async () => {
  const a = await upsertConnectedNumber(pool, { workspaceId: 'ws-A', evolutionInstance: 'a-i', phone: '+5531666', createdBy: null });
  await setNumberLifecycle(pool, a.id, { status: 'disconnected', removed: true });
  await createProvisioning(pool, { evolutionInstance: 'b-i', workspaceId: 'ws-B', createdBy: null, ttlSeconds: 90 });
  await handleConnectionEvent(pool, { event: 'connection.update', instance: 'b-i', data: { state: 'open', wuid: '5531666@s.whatsapp.net' } });
  const b = await pool.query(`SELECT id FROM whatsapp_numbers WHERE workspace_id='ws-B'`);
  assert.equal(b.rows.length, 1);
  assert.notEqual(Number(b.rows[0].id), a.id); // ficha nova, não a do ws-A
});

test('staging open SEM telefone extraível → não revive, cria ficha (phone null)', async () => {
  await createProvisioning(pool, { evolutionInstance: 'np-i', workspaceId: 'ws-Z', createdBy: null, ttlSeconds: 90 });
  await handleConnectionEvent(pool, { event: 'connection.update', instance: 'np-i', data: { state: 'open' } });
  const { rows } = await pool.query(`SELECT phone, status FROM whatsapp_numbers WHERE evolution_instance='np-i'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, null);
  assert.equal(rows[0].status, 'connected');
});
