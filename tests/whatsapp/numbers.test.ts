import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { createNumber, getNumberByInstance, updateNumberStatus, listNumbers, upsertConnectedNumber, renameNumberLabel } from '../../src/whatsapp/numbers.js';
import { setNumberLifecycle, reviveByWorkspacePhone, normalizePhone } from '../../src/whatsapp/numbers.js';

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

test('listNumbers esconde removidos por default; includeRemoved mostra', async () => {
  const keep = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'k', phone: '+1', createdBy: null });
  const gone = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'g', phone: '+2', createdBy: null });
  await setNumberLifecycle(pool, gone.id, { status: 'disconnected', removed: true });
  const def = await listNumbers(pool, 'ws-1');
  assert.deepEqual(def.map((n) => n.id), [keep.id]);
  const all = await listNumbers(pool, 'ws-1', { includeRemoved: true });
  assert.equal(all.length, 2);
});

test('normalizePhone canoniza pra +E164', () => {
  assert.equal(normalizePhone('5531999@s.whatsapp.net'), '+5531999');
  assert.equal(normalizePhone('+55 (31) 99-9'), '+5531999'); // só dígitos
  assert.equal(normalizePhone(''), undefined);
  assert.equal(normalizePhone(null), undefined);
});

test('setNumberLifecycle remove seta removed_at; disconnect não', async () => {
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'inst-a', phone: '+551', createdBy: null });
  await setNumberLifecycle(pool, n.id, { status: 'disconnected', removed: false });
  let r = await pool.query(`SELECT status, removed_at FROM whatsapp_numbers WHERE id=$1`, [n.id]);
  assert.equal(r.rows[0].status, 'disconnected');
  assert.equal(r.rows[0].removed_at, null);
  await setNumberLifecycle(pool, n.id, { status: 'disconnected', removed: true });
  r = await pool.query(`SELECT removed_at FROM whatsapp_numbers WHERE id=$1`, [n.id]);
  assert.ok(r.rows[0].removed_at);
});

test('reviveByWorkspacePhone revive ficha removida (mesmo number_id, removed_at=null, nova instância)', async () => {
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'old-inst', phone: '+5531888', createdBy: null });
  await setNumberLifecycle(pool, n.id, { status: 'disconnected', removed: true });
  const out = await reviveByWorkspacePhone(pool, { workspaceId: 'ws-1', phone: '+5531888', evolutionInstance: 'new-inst' });
  assert.ok(out);
  assert.equal(out!.number.id, n.id);
  assert.equal(out!.number.status, 'connected');
  assert.equal(out!.number.removedAt, null);
  assert.equal(out!.number.evolutionInstance, 'new-inst');
  assert.equal(out!.oldInstance, 'old-inst');
});

test('reviveByWorkspacePhone não revive ficha já connected; retorna null', async () => {
  await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'live', phone: '+5531777', createdBy: null });
  const out = await reviveByWorkspacePhone(pool, { workspaceId: 'ws-1', phone: '+5531777', evolutionInstance: 'other' });
  assert.equal(out, null);
});

test('reviveByWorkspacePhone é escopada ao workspace (não cruza)', async () => {
  const a = await upsertConnectedNumber(pool, { workspaceId: 'ws-A', evolutionInstance: 'a-inst', phone: '+5531666', createdBy: null });
  await setNumberLifecycle(pool, a.id, { status: 'disconnected', removed: true });
  const out = await reviveByWorkspacePhone(pool, { workspaceId: 'ws-B', phone: '+5531666', evolutionInstance: 'b-inst' });
  assert.equal(out, null);
});
