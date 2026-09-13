import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { upsertConnectedNumber, updateNumberStatus } from '../../src/whatsapp/numbers.js';
import {
  claimNumberNotification,
  claimSystemNotification,
  listDownNumbers,
  recordSystemHealth,
  releaseNumberNotification,
  releaseSystemNotification,
} from '../../src/whatsapp/down-notify-store.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE system_instance_health');
});
after(() => pool.end());

async function downNumber(p: { instance: string; phone: string | null; minutesDown: number; removed?: boolean }) {
  const n = await upsertConnectedNumber(pool, {
    workspaceId: 'ws-1', evolutionInstance: p.instance, phone: p.phone ?? undefined, createdBy: null,
  });
  await pool.query(
    `UPDATE whatsapp_numbers
        SET status = 'disconnected',
            disconnected_since = NOW() - ($2 || ' minutes')::interval,
            removed_at = CASE WHEN $3::boolean THEN NOW() END
      WHERE id = $1`,
    [n.id, String(p.minutesDown), p.removed === true],
  );
  return n;
}

const fresh = { lastNotifiedAt: null, notifyCount: 0 };

test('lista só número fora do ar, não removido e com telefone', async () => {
  const a = await downNumber({ instance: 'i-a', phone: '+5531111', minutesDown: 30 });
  await downNumber({ instance: 'i-b', phone: null, minutesDown: 30 });
  await downNumber({ instance: 'i-c', phone: '+5531333', minutesDown: 30, removed: true });
  await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'i-d', phone: '+5531444', createdBy: null });

  const rows = await listDownNumbers(pool);
  assert.deepEqual(rows.map((r) => r.id), [a.id]);
  assert.equal(rows[0].phone, '+5531111');
  assert.equal(rows[0].instance, 'i-a');
  assert.equal(rows[0].workspaceId, 'ws-1');
  assert.equal(rows[0].notifyCount, 0);
  assert.equal(rows[0].lastNotifiedAt, null);
  assert.ok(rows[0].downSince instanceof Date);
});

test('claim é otimista: a mesma leitura só reivindica uma vez', async () => {
  const n = await downNumber({ instance: 'i-a', phone: '+5531111', minutesDown: 30 });
  assert.equal(await claimNumberNotification(pool, n.id, fresh), true);
  assert.equal(await claimNumberNotification(pool, n.id, fresh), false);
  const [r] = await listDownNumbers(pool);
  assert.equal(r.notifyCount, 1);
  assert.ok(r.lastNotifiedAt instanceof Date);
});

test('release devolve o claim e permite reivindicar de novo', async () => {
  const n = await downNumber({ instance: 'i-a', phone: '+5531111', minutesDown: 30 });
  await claimNumberNotification(pool, n.id, fresh);
  await releaseNumberNotification(pool, n.id, fresh);
  const [r] = await listDownNumbers(pool);
  assert.equal(r.notifyCount, 0);
  assert.equal(r.lastNotifiedAt, null);
  assert.equal(await claimNumberNotification(pool, n.id, fresh), true);
});

test('reconectar zera o episódio de aviso', async () => {
  const n = await downNumber({ instance: 'i-a', phone: '+5531111', minutesDown: 30 });
  await claimNumberNotification(pool, n.id, fresh);
  await updateNumberStatus(pool, 'i-a', { status: 'connected' });
  const { rows } = await pool.query(
    `SELECT down_notified_at, down_notify_count FROM whatsapp_numbers WHERE id = $1`, [n.id],
  );
  assert.equal(rows[0].down_notified_at, null);
  assert.equal(rows[0].down_notify_count, 0);
});

test('claim não reivindica número que já reconectou', async () => {
  const n = await downNumber({ instance: 'i-a', phone: '+5531111', minutesDown: 30 });
  await updateNumberStatus(pool, 'i-a', { status: 'connected' });
  assert.equal(await claimNumberNotification(pool, n.id, fresh), false);
});

const saturno = { instance: 'saturno', expectedPhone: '+553195950748', label: 'Monitor de grupos' };
const verdict = (down: boolean) => ({
  down,
  reason: down ? ('state' as const) : null,
  state: down ? ('close' as const) : ('open' as const),
  ownStoreTs: null,
  peerStoreTs: null,
});

test('sistema: saudável→fora abre o episódio; fora→fora preserva o início', async () => {
  const a = await recordSystemHealth(pool, saturno, verdict(true));
  assert.ok(a.downSince instanceof Date);
  await new Promise((r) => setTimeout(r, 20));
  const b = await recordSystemHealth(pool, saturno, verdict(true));
  assert.equal(b.downSince!.getTime(), a.downSince!.getTime());
  assert.equal(b.expectedPhone, '+553195950748');
});

test('sistema: fora→saudável encerra o episódio e zera o aviso', async () => {
  await recordSystemHealth(pool, saturno, verdict(true));
  await claimSystemNotification(pool, 'saturno', fresh);
  const r = await recordSystemHealth(pool, saturno, verdict(false));
  assert.equal(r.downSince, null);
  assert.equal(r.lastNotifiedAt, null);
  assert.equal(r.notifyCount, 0);
});

test('sistema: claim e release otimistas', async () => {
  await recordSystemHealth(pool, saturno, verdict(true));
  assert.equal(await claimSystemNotification(pool, 'saturno', fresh), true);
  assert.equal(await claimSystemNotification(pool, 'saturno', fresh), false);
  await releaseSystemNotification(pool, 'saturno', fresh);
  assert.equal(await claimSystemNotification(pool, 'saturno', fresh), true);
});

test('sistema: claim não reivindica instância saudável', async () => {
  await recordSystemHealth(pool, saturno, verdict(false));
  assert.equal(await claimSystemNotification(pool, 'saturno', fresh), false);
});

test('sistema: abre o episódio no início observado; episódio aberto não é reescrito', async () => {
  const observed = new Date('2026-09-09T21:10:00.000Z');
  const a = await recordSystemHealth(pool, saturno, verdict(true), observed);
  assert.equal(a.downSince!.getTime(), observed.getTime());
  const b = await recordSystemHealth(pool, saturno, verdict(true), new Date('2026-09-11T00:00:00.000Z'));
  assert.equal(b.downSince!.getTime(), observed.getTime());
});
