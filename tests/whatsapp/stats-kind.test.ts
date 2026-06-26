/**
 * tests/whatsapp/stats-kind.test.ts
 *
 * Cobre o filtro `kind` em getStats:
 *   - kind='dm' escopa TODOS os buckets thread-level (total, byLeadStatus, byStage,
 *     byTemperature, bySource, byTag) a DMs
 *   - kind='group' escopa a grupos
 *   - kind='all' (e default) = soma, idêntico ao atual
 *   - byKind e byIngestSource ficam IMUNES (idênticos sob qualquer kind)
 *   - cenário "130,8%": grupos-lead não inflam o lead-rate quando kind='dm'
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { getStats } from '../../src/whatsapp/stats.js';

const TRUNCATE = `TRUNCATE messages, whatsapp_numbers, whatsapp_thread_meta, whatsapp_groups, whatsapp_thread_tags RESTART IDENTITY CASCADE`;
beforeEach(async () => { await pool.query(TRUNCATE); });
after(() => pool.end());

async function insertNumber(id: number, ws: string) {
  await pool.query(
    `INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES ($1, $2, $3)`,
    [id, ws, `inst-${id}`],
  );
}
async function insertMsg(numberId: number, ws: string, identifier: string, createdAt: string, ingestSource = 'live') {
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, ingest_source, created_at)
     VALUES ($1, $2, 'whatsapp', $3, 'inbound', 'msg', $4, $5)`,
    [numberId, ws, identifier, ingestSource, createdAt],
  );
}
// Marca uma thread como grupo (row em whatsapp_groups).
async function makeGroup(numberId: number, ws: string, jid: string, subject: string) {
  await pool.query(
    `INSERT INTO whatsapp_groups (jid, subject, whatsapp_number_id, workspace_id)
     VALUES ($1, $2, $3, $4)`,
    [jid, subject, numberId, ws],
  );
}
async function setMeta(numberId: number, identifier: string, cols: Record<string, string | boolean>) {
  const keys = Object.keys(cols);
  const setList = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  const insCols = keys.join(', ');
  const insVals = keys.map((_, i) => `$${i + 3}`).join(', ');
  await pool.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, ${insCols})
     VALUES ($1, $2, ${insVals})
     ON CONFLICT (whatsapp_number_id, identifier) DO UPDATE SET ${setList}`,
    [numberId, identifier, ...keys.map(k => cols[k])],
  );
}

test('kind: escopa todos os buckets thread-level + byKind/byIngestSource imunes', async () => {
  const ws = 'ws-kind';
  await insertNumber(1, ws);

  // DM marcada lead, qualificado, quente, instagram, tag vip
  await insertMsg(1, ws, 'dm-1', '2026-01-10T00:00:00Z');
  await setMeta(1, 'dm-1', { is_lead: true, lead_stage: 'qualificado', lead_temperature: 'quente', lead_source: 'instagram' });
  await pool.query(
    `INSERT INTO whatsapp_thread_tags (whatsapp_number_id, identifier, tag) VALUES (1, 'dm-1', 'vip')`,
  );

  // Grupo 1 marcado lead, cliente, frio
  await makeGroup(1, ws, 'grp-1@g.us', 'Grupo 1');
  await insertMsg(1, ws, 'grp-1@g.us', '2026-01-11T00:00:00Z', 'backfill');
  await setMeta(1, 'grp-1@g.us', { is_lead: true, lead_stage: 'cliente', lead_temperature: 'frio' });

  // Grupo 2 marcado lead
  await makeGroup(1, ws, 'grp-2@g.us', 'Grupo 2');
  await insertMsg(1, ws, 'grp-2@g.us', '2026-01-12T00:00:00Z');
  await setMeta(1, 'grp-2@g.us', { is_lead: true });

  const all = await getStats(pool, { workspaceId: ws, numberId: 1, kind: 'all' });
  const dm = await getStats(pool, { workspaceId: ws, numberId: 1, kind: 'dm' });
  const grp = await getStats(pool, { workspaceId: ws, numberId: 1, kind: 'group' });
  const def = await getStats(pool, { workspaceId: ws, numberId: 1 }); // default = all

  // kind='all' == default
  assert.deepEqual(def, all, 'default kind behaves as all');

  // total escopado
  assert.equal(all.total, 3);
  assert.equal(dm.total, 1, 'dm: só a DM');
  assert.equal(grp.total, 2, 'group: só os 2 grupos');

  // byLeadStatus escopado — o cenário "130,8%": com kind=dm, lead <= dm
  assert.equal(all.byLeadStatus.lead, 3);
  assert.equal(dm.byLeadStatus.lead, 1, 'dm: 1 lead (não infla com grupos)');
  assert.ok(dm.byLeadStatus.lead <= dm.byKind.dm, 'lead <= contato em dm-scope');

  // byStage/byTemperature/bySource/byTag escopados
  assert.deepEqual(dm.byStage, { qualificado: 1 });
  assert.deepEqual(grp.byStage, { cliente: 1, null: 1 });
  assert.deepEqual(dm.byTemperature, { quente: 1 });
  assert.deepEqual(dm.bySource, { instagram: 1 });
  assert.deepEqual(dm.byTag, { vip: 1 });
  assert.deepEqual(grp.byTag, {}, 'grupos não têm tag');

  // byKind IMUNE: idêntico sob qualquer kind
  assert.deepEqual(all.byKind, { dm: 1, group: 2 });
  assert.deepEqual(dm.byKind, { dm: 1, group: 2 }, 'byKind imune ao filtro');
  assert.deepEqual(grp.byKind, { dm: 1, group: 2 }, 'byKind imune ao filtro');

  // byIngestSource IMUNE: idêntico sob qualquer kind (message-level)
  assert.deepEqual(dm.byIngestSource, all.byIngestSource, 'byIngestSource imune');
  assert.deepEqual(grp.byIngestSource, all.byIngestSource, 'byIngestSource imune');
  assert.equal(all.byIngestSource['live'], 2);
  assert.equal(all.byIngestSource['backfill'], 1);
});

test('kind: grupo sem row em whatsapp_groups mas com author conta como grupo', async () => {
  const ws = 'ws-author';
  await insertNumber(2, ws);
  // Thread de grupo SEM row em whatsapp_groups, identificada por author não-nulo
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, author, created_at)
     VALUES (2, $1, 'whatsapp', 'grp-author', 'inbound', 'msg', '5531999@s.whatsapp.net', '2026-01-10T00:00:00Z')`,
    [ws],
  );
  // DM pura
  await insertMsg(2, ws, 'dm-pure', '2026-01-11T00:00:00Z');

  const dm = await getStats(pool, { workspaceId: ws, numberId: 2, kind: 'dm' });
  const grp = await getStats(pool, { workspaceId: ws, numberId: 2, kind: 'group' });
  assert.equal(dm.total, 1, 'dm: só dm-pure');
  assert.equal(grp.total, 1, 'group: grp-author (via author)');
});
