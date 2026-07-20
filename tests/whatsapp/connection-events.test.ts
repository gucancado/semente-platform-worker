import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { handleConnectionEvent } from '../../src/whatsapp/connection-events.js';
import { createProvisioning, getProvisioning } from '../../src/whatsapp/provisioning.js';
import { markProvisioningBlocked as _mpb } from '../../src/whatsapp/provisioning.js';
import { upsertConnectedNumber, setNumberLifecycle } from '../../src/whatsapp/numbers.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE whatsapp_provisioning');
  await pool.query('TRUNCATE whatsapp_provision_links');
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

test('open: move cross-workspace com histórico (mensagens re-carimbadas)', async () => {
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-A', evolutionInstance: 'old-i', phone: '+5531777', createdBy: 'u1' });
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text) VALUES ($1,'ws-A','whatsapp','+55x','inbound','oi')`, [n.id]);
  await setNumberLifecycle(pool, n.id, { status: 'disconnected', removed: true });
  await createProvisioning(pool, { evolutionInstance: 'new-i', workspaceId: 'ws-B', createdBy: 'u1', ttlSeconds: 90 });
  await handleConnectionEvent(pool, { event: 'connection.update', instance: 'new-i', data: { state: 'open', wuid: '5531777@s.whatsapp.net' } });
  const { rows } = await pool.query(`SELECT id, workspace_id FROM whatsapp_numbers WHERE phone='+5531777'`);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].id), n.id);
  assert.equal(rows[0].workspace_id, 'ws-B');
  const m = await pool.query(`SELECT workspace_id FROM messages WHERE whatsapp_number_id=$1`, [n.id]);
  assert.equal(m.rows[0].workspace_id, 'ws-B');
});

test('open: número ATIVO em outro ws → bloqueia (marca staging, não move, apaga instância nova via mock)', async () => {
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-A', evolutionInstance: 'live-i', phone: '+5531888', createdBy: null });
  await createProvisioning(pool, { evolutionInstance: 'try-i', workspaceId: 'ws-B', createdBy: null, ttlSeconds: 90 });
  await handleConnectionEvent(pool, { event: 'connection.update', instance: 'try-i', data: { state: 'open', wuid: '5531888@s.whatsapp.net' } });
  const row = await pool.query(`SELECT workspace_id FROM whatsapp_numbers WHERE id=$1`, [n.id]);
  assert.equal(row.rows[0].workspace_id, 'ws-A'); // intacta
  const prov = await pool.query(`SELECT blocked_workspace_id FROM whatsapp_provisioning WHERE evolution_instance='try-i'`);
  assert.equal(prov.rows[0].blocked_workspace_id, 'ws-A'); // staging marcado (não apagado)
});

test('open: telefone novo do staging → insert', async () => {
  await createProvisioning(pool, { evolutionInstance: 'fresh-i', workspaceId: 'ws-Z', createdBy: null, ttlSeconds: 90 });
  await handleConnectionEvent(pool, { event: 'connection.update', instance: 'fresh-i', data: { state: 'open', wuid: '5531000@s.whatsapp.net' } });
  const { rows } = await pool.query(`SELECT status FROM whatsapp_numbers WHERE evolution_instance='fresh-i'`);
  assert.equal(rows[0].status, 'connected');
});

test('staging open SEM telefone extraível → não revive, cria ficha (phone null)', async () => {
  await createProvisioning(pool, { evolutionInstance: 'np-i', workspaceId: 'ws-Z', createdBy: null, ttlSeconds: 90 });
  await handleConnectionEvent(pool, { event: 'connection.update', instance: 'np-i', data: { state: 'open' } });
  const { rows } = await pool.query(`SELECT phone, status FROM whatsapp_numbers WHERE evolution_instance='np-i'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, null);
  assert.equal(rows[0].status, 'connected');
});

test('connect via link marca o link como consumed', async () => {
  const { createProvisionLink, getProvisionLink, generateLinkToken } = await import('../../src/whatsapp/provision-links.js');
  const { createProvisioning } = await import('../../src/whatsapp/provisioning.js');
  const token = generateLinkToken();
  await createProvisionLink(pool, { token, workspaceId: 'ws-link', createdBy: null, maxClicks: 10, ttlDays: 7 });
  await createProvisioning(pool, { evolutionInstance: 'inst-link', workspaceId: 'ws-link', createdBy: null, ttlSeconds: 90, provisionLinkToken: token });
  await handleConnectionEvent(pool, { event: 'connection.update', instance: 'inst-link', data: { state: 'open', wuid: '5511999998888@s.whatsapp.net' } });
  const link = await getProvisionLink(pool, token);
  assert.equal(link?.status, 'consumed');
  assert.ok(link?.connectedNumberId);
});
