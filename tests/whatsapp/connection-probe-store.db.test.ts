import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import {
  createProbe,
  markProbeSent,
  recordProbeReceipt,
  recordCloudStatuses,
  listOpenProbes,
  setVerdict,
  probeHistory,
  takenCodes,
} from '../../src/whatsapp/connection-probe-store.js';
import type { MessageKey } from '../../src/evolution/client.js';

beforeEach(async () => {
  await pool.query('TRUNCATE connection_probes RESTART IDENTITY CASCADE');
});
after(() => pool.end());

const key = (id: string): MessageKey => ({ id, remoteJid: '553199999999@s.whatsapp.net', fromMe: false });

function base(instance: string, code: string, extra: Partial<Parameters<typeof createProbe>[1]> = {}) {
  return {
    instance,
    kind: 'number' as const,
    numberId: null,
    phone: '+553199999999',
    label: 'Número teste',
    trigger: 'quiet' as const,
    code,
    ...extra,
  };
}

test('createProbe: segunda sonda para a mesma instância enquanto a 1ª está aberta devolve null', async () => {
  const p1 = await createProbe(pool, base('inst-a', 'AAAA'));
  assert.ok(p1);
  assert.equal(p1!.instance, 'inst-a');
  assert.equal(p1!.code, 'AAAA');
  assert.equal(p1!.parentId, null);

  const p2 = await createProbe(pool, base('inst-a', 'BBBB'));
  assert.equal(p2, null);

  // outra instância não é afetada pelo índice único
  const p3 = await createProbe(pool, base('inst-b', 'CCCC'));
  assert.ok(p3);
});

test('markProbeSent com sendError grava verdict=send_failed e persiste o wamid', async () => {
  const p = await createProbe(pool, base('inst-a', 'AAAA'));
  await markProbeSent(pool, p!.id, { wamid: 'wamid.1', mirrorWamid: null, sendError: { message: 'boom' } });

  const { rows } = await pool.query(
    `SELECT wamid, verdict, verdict_at, send_error FROM connection_probes WHERE id = $1`,
    [p!.id],
  );
  assert.equal(rows[0].wamid, 'wamid.1');
  assert.equal(rows[0].verdict, 'send_failed');
  assert.ok(rows[0].verdict_at instanceof Date);
  assert.equal(rows[0].send_error.message, 'boom');
});

test('markProbeSent sem sendError não mexe no verdict', async () => {
  const p = await createProbe(pool, base('inst-a', 'AAAA'));
  await markProbeSent(pool, p!.id, { wamid: 'wamid.2', mirrorWamid: 'wamid.2m', sendError: null });

  const { rows } = await pool.query(
    `SELECT wamid, mirror_wamid, verdict, sent_at FROM connection_probes WHERE id = $1`,
    [p!.id],
  );
  assert.equal(rows[0].wamid, 'wamid.2');
  assert.equal(rows[0].mirror_wamid, 'wamid.2m');
  assert.equal(rows[0].verdict, null);
  assert.ok(rows[0].sent_at instanceof Date);
});

test('recordProbeReceipt casa pelo código e é idempotente', async () => {
  const p = await createProbe(pool, base('inst-a', 'CODE'));
  const r1 = await recordProbeReceipt(pool, 'inst-a', 'CODE', key('m1'));
  assert.ok(r1);
  assert.equal(r1!.id, p!.id);
  assert.ok(r1!.receivedAt instanceof Date);
  assert.deepEqual(r1!.msgKey, key('m1'));

  const r2 = await recordProbeReceipt(pool, 'inst-a', 'CODE', key('m2'));
  assert.ok(r2);
  assert.equal(r2!.receivedAt.getTime(), r1!.receivedAt!.getTime());
  assert.deepEqual(r2!.msgKey, key('m1')); // não sobrescreve com a 2ª key

  // código inexistente não casa nada
  const r3 = await recordProbeReceipt(pool, 'inst-a', 'NADA', key('m3'));
  assert.equal(r3, null);
});

test('recordCloudStatuses: delivered depois sent não regride; failed grava cloud_error', async () => {
  const p1 = await createProbe(pool, base('inst-a', 'AAAA'));
  await markProbeSent(pool, p1!.id, { wamid: 'wamid.d1', mirrorWamid: null, sendError: null });

  const n1 = await recordCloudStatuses(pool, [{ id: 'wamid.d1', status: 'delivered', errors: [] }]);
  assert.equal(n1, 1);
  let row = (await pool.query(`SELECT cloud_status FROM connection_probes WHERE id = $1`, [p1!.id])).rows[0];
  assert.equal(row.cloud_status, 'delivered');

  const n2 = await recordCloudStatuses(pool, [{ id: 'wamid.d1', status: 'sent', errors: [] }]);
  assert.equal(n2, 0);
  row = (await pool.query(`SELECT cloud_status FROM connection_probes WHERE id = $1`, [p1!.id])).rows[0];
  assert.equal(row.cloud_status, 'delivered');

  // wamid desconhecido: nenhuma linha afetada, sem lançar
  const n3 = await recordCloudStatuses(pool, [{ id: 'wamid.inexistente', status: 'delivered', errors: [] }]);
  assert.equal(n3, 0);

  // failed grava cloud_error
  const p2 = await createProbe(pool, base('inst-b', 'BBBB'));
  await markProbeSent(pool, p2!.id, { wamid: 'wamid.f1', mirrorWamid: null, sendError: null });
  const n4 = await recordCloudStatuses(pool, [
    { id: 'wamid.f1', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] },
  ]);
  assert.equal(n4, 1);
  row = (await pool.query(`SELECT cloud_status, cloud_error FROM connection_probes WHERE id = $1`, [p2!.id])).rows[0];
  assert.equal(row.cloud_status, 'failed');
  assert.deepEqual(row.cloud_error, [{ code: 131047, title: 'Re-engagement message' }]);
});

test('corrida: recordProbeReceipt antes de setVerdict(down) devolve received e grava alive', async () => {
  const p = await createProbe(pool, base('inst-a', 'RACE'));
  await recordProbeReceipt(pool, 'inst-a', 'RACE', key('late'));

  const outcome = await setVerdict(pool, p!.id, 'down');
  assert.equal(outcome, 'received');

  const row = (await pool.query(`SELECT verdict FROM connection_probes WHERE id = $1`, [p!.id])).rows[0];
  assert.equal(row.verdict, 'alive');
});

test('setVerdict duas vezes: a 2ª devolve already e não sobrescreve', async () => {
  const p = await createProbe(pool, base('inst-a', 'AAAA'));
  const first = await setVerdict(pool, p!.id, 'inconclusive');
  assert.equal(first, 'set');
  const second = await setVerdict(pool, p!.id, 'down');
  assert.equal(second, 'already');

  const row = (await pool.query(`SELECT verdict FROM connection_probes WHERE id = $1`, [p!.id])).rows[0];
  assert.equal(row.verdict, 'inconclusive'); // não foi sobrescrito por 'down'
});

test('listOpenProbes lista só sondas sem veredito, com ageMs', async () => {
  const p1 = await createProbe(pool, base('inst-a', 'AAAA'));
  await setVerdict(pool, p1!.id, 'inconclusive');
  const p2 = await createProbe(pool, base('inst-b', 'BBBB'));

  const open = await listOpenProbes(pool);
  assert.deepEqual(open.map((r) => r.id).sort(), [p2!.id].sort());
  assert.equal(typeof open[0].ageMs, 'number');
  assert.ok(open[0].ageMs >= 0);
});

test('takenCodes devolve os códigos dos últimos 7 dias só da instância pedida', async () => {
  const p1 = await createProbe(pool, base('inst-a', 'ZZZZ'));
  await setVerdict(pool, p1!.id, 'inconclusive');
  const p2 = await createProbe(pool, base('inst-a', 'YYYY'));
  await setVerdict(pool, p2!.id, 'inconclusive');
  await createProbe(pool, base('inst-b', 'XXXX'));

  const taken = await takenCodes(pool, 'inst-a');
  assert.deepEqual([...taken].sort(), ['YYYY', 'ZZZZ']);
  assert.ok(!taken.has('XXXX'));
});

test('probeHistory: após alive, lastVerdict é alive e recente; primárias em 24h contam só parent_id nulo', async () => {
  const instance = 'inst-hist';
  const p1 = await createProbe(pool, base(instance, 'AAAA'));
  await setVerdict(pool, p1!.id, 'inconclusive');
  const p2 = await createProbe(pool, base(instance, 'BBBB'));
  await setVerdict(pool, p2!.id, 'inconclusive');
  const p3 = await createProbe(pool, base(instance, 'CCCC'));
  await setVerdict(pool, p3!.id, 'alive');

  const h1 = await probeHistory(pool, instance);
  assert.equal(h1.hasOpen, false);
  assert.ok(h1.lastVerdict);
  assert.equal(h1.lastVerdict!.verdict, 'alive');
  assert.ok(h1.lastVerdict!.ageMs < 60_000);
  assert.equal(h1.primaryCount24h, 3);

  // repetição (parent_id preenchido) não conta como primária
  const p4 = await createProbe(pool, base(instance, 'DDDD', { parentId: p3!.id }));
  await setVerdict(pool, p4!.id, 'inconclusive');
  const h2 = await probeHistory(pool, instance);
  assert.equal(h2.primaryCount24h, 3);
});

test('probeHistory: consecutiveInconclusive ignora repeated e para no primeiro veredito diferente', async () => {
  const instance = 'inst-consec';
  const q1 = await createProbe(pool, base(instance, 'AAAA'));
  await setVerdict(pool, q1!.id, 'inconclusive');
  const q2 = await createProbe(pool, base(instance, 'BBBB'));
  await setVerdict(pool, q2!.id, 'inconclusive');

  assert.equal((await probeHistory(pool, instance)).consecutiveInconclusive, 2);

  // 'repeated' é excluído da sequência — nem quebra nem soma a corrida.
  const q3 = await createProbe(pool, base(instance, 'CCCC'));
  await setVerdict(pool, q3!.id, 'repeated');
  const q4 = await createProbe(pool, base(instance, 'DDDD', { parentId: q3!.id }));
  await setVerdict(pool, q4!.id, 'inconclusive');

  assert.equal((await probeHistory(pool, instance)).consecutiveInconclusive, 3);

  // um veredito diferente no topo zera a contagem
  const q5 = await createProbe(pool, base(instance, 'EEEE'));
  await setVerdict(pool, q5!.id, 'alive');
  assert.equal((await probeHistory(pool, instance)).consecutiveInconclusive, 0);
});

test('probeHistory: lastQuietAgeMs é a idade da última PRIMÁRIA com trigger quiet', async () => {
  const instance = 'inst-quiet';
  const p1 = await createProbe(pool, base(instance, 'AAAA', { trigger: 'store_stale' }));
  await setVerdict(pool, p1!.id, 'inconclusive');
  let h = await probeHistory(pool, instance);
  assert.equal(h.lastQuietAgeMs, null);

  const p2 = await createProbe(pool, base(instance, 'BBBB', { trigger: 'quiet' }));
  await setVerdict(pool, p2!.id, 'inconclusive');
  h = await probeHistory(pool, instance);
  assert.ok(h.lastQuietAgeMs !== null && h.lastQuietAgeMs < 60_000);
});

test('probeHistory: hasOpen é true enquanto houver sonda sem veredito', async () => {
  const instance = 'inst-open';
  await createProbe(pool, base(instance, 'AAAA'));
  const h = await probeHistory(pool, instance);
  assert.equal(h.hasOpen, true);
  assert.equal(h.lastVerdict, null);
});
