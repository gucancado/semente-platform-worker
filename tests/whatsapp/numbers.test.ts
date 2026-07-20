import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { createNumber, getNumberByInstance, updateNumberStatus, listNumbers, upsertConnectedNumber, renameNumberLabel } from '../../src/whatsapp/numbers.js';
import { setNumberLifecycle, normalizePhone } from '../../src/whatsapp/numbers.js';
import { claimNumberByPhone } from '../../src/whatsapp/numbers.js';

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

test('reconectar (updateNumberStatus connected) limpa removed_at → número volta pra nav', async () => {
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'inst-recon', phone: '+552', createdBy: null });
  await setNumberLifecycle(pool, n.id, { status: 'disconnected', removed: true });
  // removido some da nav (listNumbers exclui removed_at IS NOT NULL)
  assert.equal((await listNumbers(pool, 'ws-1')).some((x) => x.id === n.id), false);
  // mesma instância reconecta → connected + removed_at limpo
  await updateNumberStatus(pool, 'inst-recon', { status: 'connected' });
  const r = await pool.query(`SELECT status, removed_at FROM whatsapp_numbers WHERE id=$1`, [n.id]);
  assert.equal(r.rows[0].status, 'connected');
  assert.equal(r.rows[0].removed_at, null);
  assert.equal((await listNumbers(pool, 'ws-1')).some((x) => x.id === n.id), true);
});

test('desconectar (não connected) NÃO mexe em removed_at', async () => {
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'inst-disc', phone: '+553', createdBy: null });
  await updateNumberStatus(pool, 'inst-disc', { status: 'disconnected' });
  const r = await pool.query(`SELECT removed_at FROM whatsapp_numbers WHERE id=$1`, [n.id]);
  assert.equal(r.rows[0].removed_at, null); // desconectado permanece na nav
});

test('claim: telefone novo → insert', async () => {
  const r = await claimNumberByPhone(pool, { phone: '+5531000', newWorkspaceId: 'ws-1', evolutionInstance: 'i1' });
  assert.equal(r.kind, 'insert');
});

test('claim: ficha inativa em outro ws → moved (move workspace, re-carimba mensagens, mantém number_id)', async () => {
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-A', evolutionInstance: 'old', phone: '+5531777', createdBy: null });
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text) VALUES ($1,'ws-A','whatsapp','+55x','inbound','oi')`, [n.id]);
  await pool.query(`INSERT INTO webhook_logs (whatsapp_number_id, workspace_id, channel, agent, identifier) VALUES ($1,'ws-A','whatsapp','x','+55x')`, [n.id]);
  await setNumberLifecycle(pool, n.id, { status: 'disconnected', removed: true });
  const r = await claimNumberByPhone(pool, { phone: '+5531777', newWorkspaceId: 'ws-B', evolutionInstance: 'new' });
  assert.equal(r.kind, 'moved');
  if (r.kind === 'moved') {
    assert.equal(r.number.id, n.id);
    assert.equal(r.number.workspaceId, 'ws-B');
    assert.equal(r.number.status, 'connected');
    assert.equal(r.number.removedAt, null);
    assert.equal(r.oldInstance, 'old');
  }
  const m = await pool.query(`SELECT workspace_id FROM messages WHERE whatsapp_number_id=$1`, [n.id]);
  assert.equal(m.rows[0].workspace_id, 'ws-B');
  const w = await pool.query(`SELECT workspace_id FROM webhook_logs WHERE whatsapp_number_id=$1`, [n.id]);
  assert.equal(w.rows[0].workspace_id, 'ws-B');
});

test('claim: ficha ATIVA em outro ws → blocked (não move)', async () => {
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-A', evolutionInstance: 'live', phone: '+5531888', createdBy: null });
  const r = await claimNumberByPhone(pool, { phone: '+5531888', newWorkspaceId: 'ws-B', evolutionInstance: 'new2' });
  assert.equal(r.kind, 'blocked');
  if (r.kind === 'blocked') assert.equal(r.currentWorkspaceId, 'ws-A');
  const row = await pool.query(`SELECT workspace_id, evolution_instance FROM whatsapp_numbers WHERE id=$1`, [n.id]);
  assert.equal(row.rows[0].workspace_id, 'ws-A');       // intacta
  assert.equal(row.rows[0].evolution_instance, 'live'); // não moveu
});

test('claim: ficha inativa no MESMO ws → moved (reconexão via onboarding)', async () => {
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'o', phone: '+5531999', createdBy: null });
  await setNumberLifecycle(pool, n.id, { status: 'disconnected', removed: false });
  const r = await claimNumberByPhone(pool, { phone: '+5531999', newWorkspaceId: 'ws-1', evolutionInstance: 'o2' });
  assert.equal(r.kind, 'moved');
  if (r.kind === 'moved') assert.equal(r.number.id, n.id);
});

test('unique global: 2ª ficha com mesmo phone viola', async () => {
  await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'a', phone: '+5531222', createdBy: null });
  await assert.rejects(() => pool.query(`INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, phone, status) VALUES ('ws-2','b','+5531222','connected')`));
});
