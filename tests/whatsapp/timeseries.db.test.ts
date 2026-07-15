/**
 * tests/whatsapp/timeseries.db.test.ts
 * SERVER-GATED: requires a live Postgres (DATABASE_URL). Local gate: pnpm typecheck.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { getTimeseries } from '../../src/whatsapp/timeseries.js';

const TRUNCATE = `TRUNCATE messages, whatsapp_numbers, whatsapp_thread_meta, whatsapp_groups, whatsapp_thread_tags RESTART IDENTITY CASCADE`;
beforeEach(async () => { await pool.query(TRUNCATE); });
after(() => pool.end());

async function insertNumber(id: number, workspaceId: string): Promise<void> {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES ($1, $2, $3)`, [id, workspaceId, `inst-${id}`]);
}
async function insertMsg(o: { numberId: number; workspaceId: string; identifier: string; createdAt: string; direction?: string; author?: string | null }): Promise<void> {
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, author, text, ingest_source, created_at)
     VALUES ($1, $2, 'whatsapp', $3, $4, $5, 'msg', 'live', $6)`,
    [o.numberId, o.workspaceId, o.identifier, o.direction ?? 'inbound', o.author ?? null, o.createdAt],
  );
}

test('arrival: thread ancora no bucket da 1ª mensagem; zero-fill preenche buckets vazios', async () => {
  await insertNumber(1, 'ws-ts');
  await insertMsg({ numberId: 1, workspaceId: 'ws-ts', identifier: 'a', createdAt: '2026-06-01T12:00:00Z' });
  await insertMsg({ numberId: 1, workspaceId: 'ws-ts', identifier: 'a', createdAt: '2026-06-05T12:00:00Z' }); // 2ª msg NÃO cria novo ponto
  await insertMsg({ numberId: 1, workspaceId: 'ws-ts', identifier: 'b', createdAt: '2026-06-03T12:00:00Z' });

  // Janela alinhada à meia-noite de São Paulo (00:00 SP = 03:00Z) — senão o
  // zero-fill cria um bucket extra do dia anterior no fuso local.
  const r = await getTimeseries(pool, {
    workspaceId: 'ws-ts', numberId: 1,
    since: '2026-06-01T03:00:00Z', until: '2026-06-06T02:59:59Z',
    periodBasis: 'arrival', bucket: 'day',
  });
  assert.equal(r.series.length, 5); // 01..05 zero-fill
  assert.equal(r.series[0].total, 1); // thread a
  assert.equal(r.series[1].total, 0); // 02: zero-fill
  assert.equal(r.series[2].total, 1); // thread b
  assert.equal(r.series.reduce((s, x) => s + x.total, 0), 2);
  assert.equal(r.series[0].leads, 1); // sem thread_meta ⇒ lead por default
});

test('activity: thread conta em cada bucket com mensagem', async () => {
  await insertNumber(2, 'ws-act');
  await insertMsg({ numberId: 2, workspaceId: 'ws-act', identifier: 'x', createdAt: '2026-06-01T12:00:00Z' });
  await insertMsg({ numberId: 2, workspaceId: 'ws-act', identifier: 'x', createdAt: '2026-06-03T12:00:00Z' });

  const r = await getTimeseries(pool, {
    workspaceId: 'ws-act', numberId: 2,
    since: '2026-06-01T03:00:00Z', until: '2026-06-04T02:59:59Z',
    periodBasis: 'activity', bucket: 'day',
  });
  assert.equal(r.series[0].total, 1);
  assert.equal(r.series[1].total, 0);
  assert.equal(r.series[2].total, 1);
});

test('kind=dm exclui grupo (author preenchido)', async () => {
  await insertNumber(3, 'ws-kind');
  await insertMsg({ numberId: 3, workspaceId: 'ws-kind', identifier: 'dm1', createdAt: '2026-06-02T12:00:00Z' });
  await insertMsg({ numberId: 3, workspaceId: 'ws-kind', identifier: 'grp', createdAt: '2026-06-02T13:00:00Z', author: 'membro' });

  const r = await getTimeseries(pool, {
    workspaceId: 'ws-kind', numberId: 3,
    since: '2026-06-02T03:00:00Z', until: '2026-06-03T02:59:59Z',
    periodBasis: 'arrival', bucket: 'day', kind: 'dm',
  });
  assert.equal(r.series[0].total, 1);
});
