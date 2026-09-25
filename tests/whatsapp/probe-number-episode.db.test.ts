// tests/whatsapp/probe-number-episode.db.test.ts
// Task 7: episódio de queda de NÚMERO confirmado pela sonda (kind='number',
// started_at_source='probe') e o efeito no aviso ao próprio número
// (listDownNumbers/claimNumberNotification tratam o "zumbi" como fora do ar;
// todo fechamento de episódio de número zera o contador de aviso).
// Ver spec 2026-09-25-sonda-conexao-whatsapp-design.md §7.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { upsertConnectedNumber, updateNumberStatus, closeOpenOutage } from '../../src/whatsapp/numbers.js';
import { listDownNumbers, claimNumberNotification } from '../../src/whatsapp/down-notify-store.js';
import {
  openNumberProbeEpisode,
  closeProbeEpisode,
  openProbeEpisodeOf,
} from '../../src/whatsapp/connection-probe-store.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, instance_outages RESTART IDENTITY CASCADE');
});
after(() => pool.end());

const fresh = { lastNotifiedAt: null, notifyCount: 0 };

async function dbNow(): Promise<Date> {
  const { rows } = await pool.query('SELECT NOW() AS now');
  return rows[0].now as Date;
}

const seed = (instance: string, phone: string) =>
  upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: instance, phone, createdBy: null });

test('numero zumbi (status=connected) com episodio probe aberto aparece em listDownNumbers com downSince=started_at e pode ser reivindicado', async () => {
  const n = await seed('i-zumbi', '+5531111');
  const firstSentAt = new Date(Date.now() - 10 * 60_000);

  const opened = await openNumberProbeEpisode(pool, {
    instance: 'i-zumbi', numberId: n.id, startedAt: null, firstSentAt, trigger: 'quiet',
  });
  assert.equal(opened, true);

  // status segue 'connected' — nada além do episódio muda em whatsapp_numbers.
  const { rows: statusRows } = await pool.query(`SELECT status FROM whatsapp_numbers WHERE id = $1`, [n.id]);
  assert.equal(statusRows[0].status, 'connected');

  const { rows: outageRows } = await pool.query(
    `SELECT started_at FROM instance_outages WHERE instance = 'i-zumbi'`,
  );
  const rows = await listDownNumbers(pool);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, n.id);
  assert.equal(rows[0].downSince.getTime(), outageRows[0].started_at.getTime());

  assert.equal(await claimNumberNotification(pool, n.id, fresh), true);
  const [claimed] = await listDownNumbers(pool);
  assert.equal(claimed.notifyCount, 1);
  assert.ok(claimed.lastNotifiedAt instanceof Date);

  const episode = await openProbeEpisodeOf(pool, 'i-zumbi');
  assert.ok(episode);
  assert.equal(episode!.kind, 'number');
  assert.equal(episode!.startedAt.getTime(), outageRows[0].started_at.getTime());
});

test('openNumberProbeEpisode: segunda chamada e DO NOTHING; data no futuro e trazida para agora', async () => {
  const n = await seed('i-futuro', '+5531222');
  const firstSentAt = new Date(Date.now() - 5 * 60_000);
  const future = new Date(Date.now() + 3_600_000);

  const opened1 = await openNumberProbeEpisode(pool, {
    instance: 'i-futuro', numberId: n.id, startedAt: future, firstSentAt, trigger: 'store_stale',
  });
  assert.equal(opened1, true);

  const now = await dbNow();
  const { rows } = await pool.query(`SELECT started_at FROM instance_outages WHERE instance = 'i-futuro'`);
  assert.equal(rows.length, 1);
  assert.ok(
    rows[0].started_at.getTime() <= now.getTime(),
    `started_at (${rows[0].started_at.toISOString()}) deveria ser <= NOW() do banco (${now.toISOString()})`,
  );

  const opened2 = await openNumberProbeEpisode(pool, {
    instance: 'i-futuro', numberId: n.id, startedAt: null, firstSentAt, trigger: 'quiet',
  });
  assert.equal(opened2, false, 'DO NOTHING: já existe episódio aberto para a instância');

  const { rows: countRows } = await pool.query(
    `SELECT count(*)::int AS n FROM instance_outages WHERE instance = 'i-futuro'`,
  );
  assert.equal(countRows[0].n, 1);
});

test('closeProbeEpisode fecha o episodio probe e zera o aviso; nao fecha episodio de fonte webhook', async () => {
  const n = await seed('i-fecha', '+5531333');
  const firstSentAt = new Date(Date.now() - 5 * 60_000);
  await openNumberProbeEpisode(pool, {
    instance: 'i-fecha', numberId: n.id, startedAt: null, firstSentAt, trigger: 'quiet',
  });
  await claimNumberNotification(pool, n.id, fresh);

  const closed = await closeProbeEpisode(pool, 'i-fecha');
  assert.equal(closed, true);

  const { rows: outageRows } = await pool.query(
    `SELECT ended_at FROM instance_outages WHERE instance = 'i-fecha'`,
  );
  assert.notEqual(outageRows[0].ended_at, null);

  const { rows: numRows } = await pool.query(
    `SELECT down_notified_at, down_notify_count FROM whatsapp_numbers WHERE id = $1`,
    [n.id],
  );
  assert.equal(numRows[0].down_notified_at, null);
  assert.equal(numRows[0].down_notify_count, 0);

  // Fechar de novo (nada aberto) devolve false.
  assert.equal(await closeProbeEpisode(pool, 'i-fecha'), false);

  // Agora abre um episódio WEBHOOK (queda de estado de verdade) — closeProbeEpisode não deve tocá-lo.
  await updateNumberStatus(pool, 'i-fecha', { status: 'disconnected' });
  const notClosed = await closeProbeEpisode(pool, 'i-fecha');
  assert.equal(notClosed, false, 'closeProbeEpisode não fecha episódio started_at_source=webhook');

  const { rows: openRows } = await pool.query(
    `SELECT started_at_source FROM instance_outages WHERE instance = 'i-fecha' AND ended_at IS NULL`,
  );
  assert.equal(openRows.length, 1);
  assert.equal(openRows[0].started_at_source, 'webhook');
});

test('closeOpenOutage (numbers.ts) zera down_notified_at/down_notify_count do numero ao fechar', async () => {
  const n = await seed('i-close-outage', '+5531444');
  await updateNumberStatus(pool, 'i-close-outage', { status: 'disconnected' });
  assert.equal(await claimNumberNotification(pool, n.id, fresh), true);

  await closeOpenOutage(pool, 'i-close-outage');

  const { rows } = await pool.query(
    `SELECT down_notified_at, down_notify_count FROM whatsapp_numbers WHERE id = $1`,
    [n.id],
  );
  assert.equal(rows[0].down_notified_at, null);
  assert.equal(rows[0].down_notify_count, 0);

  const { rows: outageRows } = await pool.query(
    `SELECT ended_at FROM instance_outages WHERE instance = 'i-close-outage'`,
  );
  assert.notEqual(outageRows[0].ended_at, null);
});

test('numero com episodio webhook aberto segue aparecendo com downSince = started_at do episodio (nao disconnected_since)', async () => {
  const n = await seed('i-webhook', '+5531555');
  await updateNumberStatus(pool, 'i-webhook', { status: 'disconnected' });

  // Desalinha started_at de disconnected_since para provar que listDownNumbers
  // lê o valor do EPISÓDIO, não o fallback.
  const earlier = new Date(Date.now() - 3_600_000);
  await pool.query(`UPDATE instance_outages SET started_at = $1 WHERE instance = 'i-webhook'`, [earlier]);

  const [row] = await listDownNumbers(pool);
  assert.ok(row);
  assert.equal(row.id, n.id);
  assert.equal(row.downSince.getTime(), earlier.getTime());

  const { rows: numRows } = await pool.query(
    `SELECT disconnected_since FROM whatsapp_numbers WHERE id = $1`,
    [n.id],
  );
  assert.notEqual(numRows[0].disconnected_since.getTime(), earlier.getTime());

  assert.equal(await claimNumberNotification(pool, n.id, fresh), true);
});
