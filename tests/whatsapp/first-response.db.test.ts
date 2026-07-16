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

// CONTRAPROVA do teste acima (direção positiva). O teste negativo sozinho ficaria
// VERDE mesmo se `WORKSPACE_NUMBERS` fosse um predicado sempre-falso — e aí grupos
// vazariam PARA DENTRO do kind='dm' (o inverso exato do bug corrigido). Este caso
// prende que `g.jid IS NOT NULL` de fato casa quando a row de grupo é do PRÓPRIO
// workspace: mesmo JID, mesmo cenário, só muda o dono da row de grupo.
test('whatsapp_groups do PRÓPRIO workspace CASA (mesmo JID) → thread é grupo, excluída do kind=dm', async () => {
  await insertNumber(12, 'ws-own-a');
  await insertNumber(13, 'ws-own-b');
  // Mesma montagem do teste anterior: thread respondida, JID compartilhado.
  await insertMsg({ numberId: 12, workspaceId: 'ws-own-a', identifier: 'shared-jid', createdAt: '2026-06-02T10:00:00Z', direction: 'inbound' });
  await insertMsg({ numberId: 12, workspaceId: 'ws-own-a', identifier: 'shared-jid', createdAt: '2026-06-02T10:30:00Z', direction: 'outbound' });
  // Diferença: quem marca o JID como grupo é o PRÓPRIO ws-own-a (não o vizinho).
  await insertGroup(12, 'ws-own-a', 'shared-jid');

  const dm = await getFirstResponse(pool, { workspaceId: 'ws-own-a' }); // default kind='dm'
  assert.equal(dm.answered, 0, 'row de grupo do próprio workspace DEVE casar → thread sai do escopo dm');
  assert.equal(dm.unanswered, 0);

  // E, sob kind='group', a mesma thread reaparece — prova que ela não sumiu, foi reclassificada.
  const grp = await getFirstResponse(pool, { workspaceId: 'ws-own-a', kind: 'group' });
  assert.equal(grp.answered, 1, 'a thread existe e é grupo');
  assert.equal(grp.medianMinutes, 30);
});

// p90 vs mediana: com UMA amostra as duas coincidem, então o teste principal não
// distingue um p90 correto de um erro de fração (0.9 → 0.09). Amostras múltiplas
// separam os dois valores e prendem a fração do PERCENTILE_CONT.
test('p90 e mediana divergem com múltiplas amostras (prende a fração do percentil)', async () => {
  await insertNumber(14, 'ws-p90');
  // 10 threads respondidas em 1..10 minutos (interpolação linear do PERCENTILE_CONT:
  // mediana = 5.5; p90 = 9.1).
  for (let i = 1; i <= 10; i++) {
    const id = `t${i}`;
    await insertMsg({ numberId: 14, workspaceId: 'ws-p90', identifier: id, createdAt: '2026-06-02T10:00:00Z', direction: 'inbound' });
    const out = new Date(Date.UTC(2026, 5, 2, 10, i, 0)).toISOString(); // 10:0i → i minutos
    await insertMsg({ numberId: 14, workspaceId: 'ws-p90', identifier: id, createdAt: out, direction: 'outbound' });
  }

  const r = await getFirstResponse(pool, { workspaceId: 'ws-p90', numberId: 14 });
  assert.equal(r.answered, 10);
  assert.equal(r.avgMinutes, 5.5);
  assert.equal(r.medianMinutes, 5.5, 'PERCENTILE_CONT(0.5) sobre 1..10 = 5.5');
  assert.equal(r.p90Minutes, 9.1, 'PERCENTILE_CONT(0.9) sobre 1..10 = 9.1 (não 5.5, não ~1.8)');
  assert.notEqual(r.p90Minutes, r.medianMinutes, 'p90 tem que divergir da mediana');
});
