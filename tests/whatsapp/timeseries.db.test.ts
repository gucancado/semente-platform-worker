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

// bucket=week: date_trunc('week') do Postgres é ISO (segunda-feira). A janela
// abaixo cobre 2 semanas ISO: 2026-06-01 (seg) .. 2026-06-14 (dom).
test('bucket=week: threads caem na semana ISO (segunda) do bucket', async () => {
  await insertNumber(4, 'ws-week');
  // Semana 1 (01–07 jun): duas threads.
  await insertMsg({ numberId: 4, workspaceId: 'ws-week', identifier: 'w1a', createdAt: '2026-06-01T12:00:00Z' });
  await insertMsg({ numberId: 4, workspaceId: 'ws-week', identifier: 'w1b', createdAt: '2026-06-07T12:00:00Z' });
  // Semana 2 (08–14 jun): uma thread.
  await insertMsg({ numberId: 4, workspaceId: 'ws-week', identifier: 'w2a', createdAt: '2026-06-10T12:00:00Z' });

  const r = await getTimeseries(pool, {
    workspaceId: 'ws-week', numberId: 4,
    since: '2026-06-01T03:00:00Z', until: '2026-06-15T02:59:59Z',
    periodBasis: 'arrival', bucket: 'week',
  });

  assert.equal(r.series.length, 2, 'duas semanas ISO na janela');
  assert.deepEqual(r.series.map(x => x.bucketStart), ['2026-06-01', '2026-06-08'], 'buckets ancorados na segunda');
  assert.equal(r.series[0].total, 2);
  assert.equal(r.series[1].total, 1);
});

// Zero-fill de semana: uma semana inteira sem conversa no meio da janela.
test('bucket=week: zero-fill preenche semana vazia no meio', async () => {
  await insertNumber(5, 'ws-week-gap');
  await insertMsg({ numberId: 5, workspaceId: 'ws-week-gap', identifier: 'g1', createdAt: '2026-06-02T12:00:00Z' }); // semana de 01/06
  await insertMsg({ numberId: 5, workspaceId: 'ws-week-gap', identifier: 'g2', createdAt: '2026-06-16T12:00:00Z' }); // semana de 15/06

  const r = await getTimeseries(pool, {
    workspaceId: 'ws-week-gap', numberId: 5,
    since: '2026-06-01T03:00:00Z', until: '2026-06-22T02:59:59Z',
    periodBasis: 'arrival', bucket: 'week',
  });

  assert.deepEqual(r.series.map(x => x.bucketStart), ['2026-06-01', '2026-06-08', '2026-06-15']);
  assert.deepEqual(r.series.map(x => x.total), [1, 0, 1], 'semana de 08/06 zerada');
});

// O identifier (JID) NÃO é único entre workspaces: sem escopo de workspace nos
// laterais, o thread_meta do ws-leak-b vazaria para o ws-leak-a e zeraria `leads`.
test('leads: thread_meta de OUTRO workspace não vaza (mesmo identifier)', async () => {
  await insertNumber(6, 'ws-leak-a');
  await insertNumber(7, 'ws-leak-b');
  // Mesmo identifier nos dois workspaces (mesmo JID de telefone).
  await insertMsg({ numberId: 6, workspaceId: 'ws-leak-a', identifier: 'shared-jid', createdAt: '2026-06-02T12:00:00Z' });
  await insertMsg({ numberId: 7, workspaceId: 'ws-leak-b', identifier: 'shared-jid', createdAt: '2026-06-02T12:00:00Z' });
  // Só o ws-leak-b marca a thread como NÃO-lead.
  await pool.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead) VALUES (7, 'shared-jid', FALSE)`,
  );

  // Agregado do workspace (numberId omitido) — o caso onde o filtro por número some.
  const r = await getTimeseries(pool, {
    workspaceId: 'ws-leak-a',
    since: '2026-06-02T03:00:00Z', until: '2026-06-03T02:59:59Z',
    periodBasis: 'arrival', bucket: 'day',
  });

  assert.equal(r.series[0].total, 1);
  assert.equal(r.series[0].leads, 1, 'ws-leak-a não tem meta → lead por default; is_lead=FALSE do ws-leak-b não pode vazar');
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
