/**
 * tests/whatsapp/first-response.db.test.ts
 * SERVER-GATED: requires a live Postgres (DATABASE_URL). Run ONE FILE AT A TIME —
 * `node --test` parallelizes files and every DB test here TRUNCATEs the shared
 * `worker_test` schema in beforeEach; concurrent files stomp each other.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { getFirstResponse } from '../../src/whatsapp/first-response.js';

const TRUNCATE = `TRUNCATE messages, whatsapp_numbers, whatsapp_thread_meta, whatsapp_groups, whatsapp_thread_tags RESTART IDENTITY CASCADE`;
beforeEach(async () => { await pool.query(TRUNCATE); });
after(() => pool.end());

async function insertNumber(id: number, workspaceId: string): Promise<void> {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES ($1, $2, $3)`, [id, workspaceId, `inst-${id}`]);
}
async function insertMsg(o: { numberId: number; workspaceId: string; identifier: string; createdAt: string; direction: string; ingestSource?: string }): Promise<void> {
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, ingest_source, created_at)
     VALUES ($1, $2, 'whatsapp', $3, $4, 'msg', $5, $6)`,
    [o.numberId, o.workspaceId, o.identifier, o.direction, o.ingestSource ?? 'live', o.createdAt],
  );
}
async function insertGroup(numberId: number, workspaceId: string, jid: string): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_groups (jid, subject, whatsapp_number_id, workspace_id) VALUES ($1, $2, $3, $4)`,
    [jid, 'grupo', numberId, workspaceId],
  );
}

test('resposta em 30min → answered=1, medianMinutes=30; thread sem outbound → unanswered', async () => {
  await insertNumber(1, 'ws-fr');
  // thread A: inbound 10:00, outbound 10:30
  await insertMsg({ numberId: 1, workspaceId: 'ws-fr', identifier: 'a', createdAt: '2026-06-02T10:00:00Z', direction: 'inbound' });
  await insertMsg({ numberId: 1, workspaceId: 'ws-fr', identifier: 'a', createdAt: '2026-06-02T10:30:00Z', direction: 'outbound' });
  // thread B: inbound sem resposta
  await insertMsg({ numberId: 1, workspaceId: 'ws-fr', identifier: 'b', createdAt: '2026-06-02T11:00:00Z', direction: 'inbound' });

  const r = await getFirstResponse(pool, { workspaceId: 'ws-fr', numberId: 1 });
  assert.equal(r.answered, 1);
  assert.equal(r.unanswered, 1);
  assert.equal(r.medianMinutes, 30);
  assert.equal(r.avgMinutes, 30);
});

test('outbound ANTES do primeiro inbound não conta como resposta', async () => {
  await insertNumber(2, 'ws-fr2');
  await insertMsg({ numberId: 2, workspaceId: 'ws-fr2', identifier: 'c', createdAt: '2026-06-02T09:00:00Z', direction: 'outbound' });
  await insertMsg({ numberId: 2, workspaceId: 'ws-fr2', identifier: 'c', createdAt: '2026-06-02T10:00:00Z', direction: 'inbound' });
  const r = await getFirstResponse(pool, { workspaceId: 'ws-fr2', numberId: 2 });
  assert.equal(r.answered, 0);
  assert.equal(r.unanswered, 1);
  // answered=0 → PERCENTILE_CONT/AVG sobre conjunto vazio devem virar null, não NaN.
  assert.equal(r.avgMinutes, null);
  assert.equal(r.medianMinutes, null);
  assert.equal(r.p90Minutes, null);
});

test('mensagens backfill são ignoradas (live-only)', async () => {
  await insertNumber(3, 'ws-fr3');
  await insertMsg({ numberId: 3, workspaceId: 'ws-fr3', identifier: 'd', createdAt: '2026-06-02T10:00:00Z', direction: 'inbound', ingestSource: 'backfill' });
  await insertMsg({ numberId: 3, workspaceId: 'ws-fr3', identifier: 'd', createdAt: '2026-06-02T10:05:00Z', direction: 'outbound', ingestSource: 'backfill' });
  const r = await getFirstResponse(pool, { workspaceId: 'ws-fr3', numberId: 3 });
  assert.equal(r.answered + r.unanswered, 0);
});

test('janela filtra pelo PRIMEIRO INBOUND da thread', async () => {
  await insertNumber(4, 'ws-fr4');
  await insertMsg({ numberId: 4, workspaceId: 'ws-fr4', identifier: 'e', createdAt: '2026-05-01T10:00:00Z', direction: 'inbound' });
  await insertMsg({ numberId: 4, workspaceId: 'ws-fr4', identifier: 'e', createdAt: '2026-06-02T10:00:00Z', direction: 'outbound' });
  const r = await getFirstResponse(pool, { workspaceId: 'ws-fr4', numberId: 4, since: '2026-06-01T00:00:00Z', until: '2026-06-30T00:00:00Z' });
  assert.equal(r.answered + r.unanswered, 0); // 1º inbound fora da janela
});

// Regressão da lição da Task 3 (bug real, achado por reviewer): o lateral de
// whatsapp_groups PRECISA escopar por workspace. `identifier` (JID) não é único
// entre workspaces — sem o escopo, uma linha de whatsapp_groups do workspace B
// classificaria erradamente uma thread do workspace A como "grupo" quando
// numberId é omitido, excluindo-a do filtro kind='dm' (default) e zerando
// answered/unanswered para uma thread que na verdade é uma DM normal.
test('whatsapp_groups de OUTRO workspace não vaza (mesmo identifier, numberId omitido)', async () => {
  await insertNumber(10, 'ws-leak-a');
  await insertNumber(11, 'ws-leak-b');
  // Mesmo identifier (JID) nos dois workspaces.
  await insertMsg({ numberId: 10, workspaceId: 'ws-leak-a', identifier: 'shared-jid', createdAt: '2026-06-02T10:00:00Z', direction: 'inbound' });
  await insertMsg({ numberId: 10, workspaceId: 'ws-leak-a', identifier: 'shared-jid', createdAt: '2026-06-02T10:30:00Z', direction: 'outbound' });
  // Só o ws-leak-b marca esse JID como grupo.
  await insertGroup(11, 'ws-leak-b', 'shared-jid');

  // Agregado do workspace (numberId omitido) — o caso onde o filtro por número some.
  const r = await getFirstResponse(pool, { workspaceId: 'ws-leak-a' }); // kind default = 'dm'
  assert.equal(r.answered, 1, 'thread de ws-leak-a é DM real; whatsapp_groups de ws-leak-b não pode reclassificá-la como grupo');
  assert.equal(r.unanswered, 0);
});
