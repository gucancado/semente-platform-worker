// tests/whatsapp/system-probe-episode.db.test.ts
// Task 8: instância de SISTEMA (saturno). `store_stale` deixa de abrir episódio
// (vira só gatilho de sonda) e a queda passa a ser CONFIRMADA pela sonda —
// `openSystemProbeEpisode` abre com `down_source='probe'`, que o tick seguinte
// com estado `open` MANTÉM. Ver spec 2026-09-25-sonda-conexao-whatsapp-design.md §7.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { assessSystemTargets, type SystemProbe } from '../../src/whatsapp/down-notify-service.js';
import { openSystemProbeEpisode, recordSystemHealth, type SystemTarget } from '../../src/whatsapp/down-notify-store.js';
import { closeProbeEpisode, openProbeEpisodeOf } from '../../src/whatsapp/connection-probe-store.js';

const H = 3_600_000;
const TICK = 5 * 60_000;
const brt = (s: string) => new Date(`${s}-03:00`);

beforeEach(async () => {
  await pool.query('TRUNCATE system_instance_health, instance_outages RESTART IDENTITY');
});
after(() => pool.end());

const saturno: SystemTarget = { instance: 'saturno', expectedPhone: '+553195950748', label: 'Monitor de grupos' };

// Terça 22/09 09:00 → quarta 23/09 10:00 = 10h de EXPEDIENTE (9h de terça + 1h de quarta).
const OWN = brt('2026-09-22T09:00:00');
const PEER = brt('2026-09-23T10:00:00');

function world(init: { state?: 'open' | 'connecting' | 'close'; own?: Date | null; peer?: Date | null } = {}) {
  const w = { state: init.state ?? 'open', own: init.own === undefined ? OWN : init.own, peer: init.peer === undefined ? PEER : init.peer };
  const probe: SystemProbe = {
    connectionState: async () => w.state,
    latestStoreTs: async (i) => (i === 'saturno' ? w.own : w.peer),
    listPeerInstances: async () => ['ws-peer'],
  };
  const deps = { pool, log: { info() {}, warn() {}, error() {} }, probe, staleMs: 6 * H, intervalMs: TICK };
  return { w, tick: async () => (await assessSystemTargets(deps, [saturno]))[0] };
}

const elapse = () => pool.query(`UPDATE system_instance_health SET checked_at = NOW() - INTERVAL '5 minutes'`);
const health = async () =>
  (
    await pool.query(
      `SELECT last_state, last_reason, down_since, down_source, down_notified_at, down_notify_count
         FROM system_instance_health WHERE instance = 'saturno'`,
    )
  ).rows[0];
const outages = async () => (await pool.query(`SELECT * FROM instance_outages ORDER BY id`)).rows;

test('saturno open com store 10h de expediente atrás do par: é GATILHO, não episódio — last_reason NULL', async () => {
  const { tick } = world();
  for (let i = 0; i < 3; i++) {
    const a = await tick();
    assert.equal(a.storeStale, true);
    assert.equal(a.verdict.reason, 'store_stale');
    assert.equal(a.row.downSince, null);
    await elapse();
  }
  const h = await health();
  assert.equal(h.last_reason, null);
  assert.equal(h.down_since, null);
  assert.equal(h.down_source, null);
  assert.equal((await outages()).length, 0);
});

test('flap: 1º tick connecting (suspeita), 2º tick open com store_stale → nenhum episódio', async () => {
  const { w, tick } = world({ state: 'connecting' });
  const first = await tick();
  assert.equal(first.storeStale, false);
  assert.equal((await health()).last_reason, 'state');
  w.state = 'open';
  await elapse();
  const second = await tick();
  assert.equal(second.storeStale, true);
  assert.equal(second.row.downSince, null);
  const h = await health();
  assert.equal(h.last_reason, null);
  assert.equal(h.down_since, null);
  assert.equal((await outages()).length, 0);
});

test('queda por ESTADO segue abrindo pelo tick, com down_source=state', async () => {
  const { tick } = world({ state: 'close' });
  await tick();
  await elapse();
  const a = await tick();
  assert.notEqual(a.row.downSince, null);
  assert.equal((await health()).down_source, 'state');
  const rows = await outages();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'state');
});

test('openSystemProbeEpisode abre com down_source=probe; tick seguinte open MANTÉM; closeProbeEpisode fecha e zera', async () => {
  const { tick } = world();
  await tick(); // linha de saúde já existe, como em prod (a sonda nasce do gatilho do tick)
  const firstSentAt = new Date(Date.now() - 10 * 60_000);

  const row = await openSystemProbeEpisode(pool, saturno, OWN, firstSentAt, 'store_stale');
  assert.equal(row.downSince?.getTime(), OWN.getTime());
  assert.equal(row.notifyCount, 0);

  let h = await health();
  assert.equal(h.down_source, 'probe');
  assert.equal((h.down_since as Date).getTime(), OWN.getTime());
  let rows = await outages();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'system');
  assert.equal(rows[0].started_at_source, 'probe');
  assert.equal(rows[0].detected_by, 'probe');
  assert.equal(rows[0].reason, 'store_stale');
  assert.equal(rows[0].ended_at, null);
  const same = await pool.query(
    `SELECT o.started_at = h.down_since AS eq FROM instance_outages o, system_instance_health h WHERE h.instance = o.instance`,
  );
  assert.equal(same.rows[0].eq, true);
  assert.equal((await openProbeEpisodeOf(pool, 'saturno'))?.kind, 'system');

  // O aviso é dado (como `runSystemInstanceWatch` faria) e o tick seguinte, com a Evolution
  // dizendo `open` (é exatamente o que mente no zumbi), NÃO fecha nem zera o aviso.
  await pool.query(`UPDATE system_instance_health SET down_notified_at = NOW(), down_notify_count = 1`);
  await elapse();
  const a = await tick();
  assert.equal(a.row.downSince?.getTime(), OWN.getTime());
  assert.equal(a.row.notifyCount, 1);
  h = await health();
  assert.equal(h.down_source, 'probe');
  assert.equal(h.down_notify_count, 1);
  assert.equal((await outages())[0].ended_at, null);

  // alive / recebimento tardio → closeProbeEpisode
  assert.equal(await closeProbeEpisode(pool, 'saturno'), true);
  h = await health();
  assert.equal(h.down_since, null);
  assert.equal(h.down_source, null);
  assert.equal(h.down_notified_at, null);
  assert.equal(h.down_notify_count, 0);
  rows = await outages();
  assert.notEqual(rows[0].ended_at, null);

  // tick depois do fechamento não reabre nada (store_stale segue sendo só gatilho)
  await elapse();
  await tick();
  assert.equal((await health()).down_since, null);
  assert.equal((await outages()).length, 1);
});

test('openSystemProbeEpisode: segunda chamada não duplica; sem início estimado usa o 1º envio; futuro vira agora', async () => {
  const firstSentAt = new Date(Date.now() - 10 * 60_000);
  // sem linha de saúde anterior (o tick nunca gravou): cria a linha
  await openSystemProbeEpisode(pool, saturno, null, firstSentAt, 'quiet');
  const h1 = await health();
  assert.equal((h1.down_since as Date).getTime(), firstSentAt.getTime());
  await openSystemProbeEpisode(pool, saturno, OWN, firstSentAt, 'quiet');
  assert.equal((await outages()).length, 1);
  assert.equal(((await health()).down_since as Date).getTime(), firstSentAt.getTime()); // aberto não é reescrito

  await pool.query('TRUNCATE system_instance_health, instance_outages RESTART IDENTITY');
  const future = new Date(Date.now() + 3 * H);
  await openSystemProbeEpisode(pool, saturno, future, future, 'quiet');
  const { rows } = await pool.query(
    `SELECT (h.down_since <= NOW()) AS h_ok, (o.started_at <= NOW()) AS o_ok, o.started_at = h.down_since AS eq
       FROM system_instance_health h JOIN instance_outages o USING (instance)`,
  );
  assert.deepEqual(rows[0], { h_ok: true, o_ok: true, eq: true });
});

test('episódio de ESTADO já aberto não é reescrito pela sonda', async () => {
  const { tick } = world({ state: 'close' });
  await tick();
  await elapse();
  await tick();
  const before = await health();
  await openSystemProbeEpisode(pool, saturno, brt('2026-09-01T09:00:00'), new Date(), 'store_stale');
  const after_ = await health();
  assert.equal(after_.down_source, 'state');
  assert.equal((after_.down_since as Date).getTime(), (before.down_since as Date).getTime());
  const rows = await outages();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].started_at_source, 'observed_store');
});

test('episódio probe fecha por TRÁFEGO real no store depois do início', async () => {
  const { w, tick } = world();
  await tick();
  await openSystemProbeEpisode(pool, saturno, OWN, new Date(Date.now() - 10 * 60_000), 'store_stale');
  await elapse();
  await tick(); // store igual: mantém
  assert.notEqual((await health()).down_since, null);

  w.own = new Date(PEER.getTime() + 60_000); // mensagem de grupo de verdade chegou
  await elapse();
  const a = await tick();
  assert.equal(a.row.downSince, null);
  const h = await health();
  assert.equal(h.down_source, null);
  assert.equal(h.down_notify_count, 0);
  assert.notEqual((await outages())[0].ended_at, null);
});

test('episódio probe + Evolution admite close: continua FORA (vira state); a volta do estado fecha', async () => {
  const { w, tick } = world();
  await tick();
  await openSystemProbeEpisode(pool, saturno, OWN, new Date(Date.now() - 10 * 60_000), 'store_stale');

  w.state = 'connecting'; // pode ser o flap de 1s: não muda a fonte
  await elapse();
  await tick();
  assert.equal((await health()).down_source, 'probe');

  w.state = 'close'; // logout do link de reconexão, ou a queda admitida
  await elapse();
  const a = await tick();
  assert.equal(a.row.downSince?.getTime(), OWN.getTime()); // não fecha como se tivesse voltado
  assert.equal((await health()).down_source, 'state');
  assert.equal((await outages())[0].ended_at, null);

  w.state = 'open'; // reconectado pelo QR (store ainda atrás do par: store_stale é só gatilho)
  await elapse();
  const b = await tick();
  assert.equal(b.row.downSince, null);
  assert.equal((await health()).down_source, null);
  const rows = await outages();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].ended_at, null);
});

test('tráfego real visto num tick CONNECTING fecha o episódio probe (não fica preso quando o estado volta a open)', async () => {
  const { w, tick } = world();
  await tick();
  await openSystemProbeEpisode(pool, saturno, OWN, new Date(Date.now() - 10 * 60_000), 'store_stale');

  w.state = 'connecting';
  w.own = new Date(PEER.getTime() + 60_000); // mensagem de grupo de verdade chega no mesmo tick
  await elapse();
  await tick();
  w.state = 'open'; // store igual ao do tick anterior
  await elapse();
  const a = await tick();
  assert.equal(a.row.downSince, null);
  const h = await health();
  assert.equal(h.down_since, null);
  assert.equal(h.down_source, null);
  const rows = await outages();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].ended_at, null);
});

test('episódio ÓRFÃO de outra fonte aberto: closeProbeEpisode ainda zera a saúde que a sonda pôs em probe', async () => {
  await pool.query(
    `INSERT INTO instance_outages (instance, kind, number_id, started_at, started_at_source, reason, detected_by)
     VALUES ('saturno', 'system', NULL, NOW() - INTERVAL '2 hours', 'observed_store', 'state', 'watch')`,
  );
  await openSystemProbeEpisode(pool, saturno, OWN, new Date(Date.now() - 10 * 60_000), 'store_stale');
  assert.equal((await health()).down_source, 'probe');
  assert.equal((await outages()).length, 1); // o órfão segue sendo o episódio

  assert.equal(await closeProbeEpisode(pool, 'saturno'), true);
  const h = await health();
  assert.equal(h.down_since, null);
  assert.equal(h.down_source, null);
  assert.equal(h.down_notify_count, 0);
});

test('recordSystemHealth recusa store_stale como queda (a porta do 21/09 fica fechada)', async () => {
  await assert.rejects(
    recordSystemHealth(pool, saturno, { down: true, reason: 'store_stale', state: 'open', ownStoreTs: OWN, peerStoreTs: PEER }),
    /store_stale não é queda/,
  );
  assert.equal(await health(), undefined);
});
