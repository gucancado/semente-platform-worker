import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { markBackfillFragments } from '../../src/whatsapp/backfill.js';

beforeEach(async () => {
  await pool.query('TRUNCATE messages, whatsapp_thread_meta, whatsapp_thread_tags, whatsapp_access_log, whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1, 'ws-1', 'inst-1')`);
});
after(() => pool.end());

async function msg(identifier: string, n = 1) {
  for (let i = 0; i < n; i++) {
    await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, ingest_source) VALUES (1,'ws-1','whatsapp',$1,'inbound','m','backfill')`, [identifier]);
  }
}
async function meta(identifier: string) {
  const { rows } = await pool.query(`SELECT is_lead, updated_by FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier=$1`, [identifier]);
  return rows[0] ?? null;
}
async function hasTag(identifier: string) {
  const { rows } = await pool.query(`SELECT 1 FROM whatsapp_thread_tags WHERE whatsapp_number_id=1 AND identifier=$1 AND tag='fragmento_backfill'`, [identifier]);
  return rows.length === 1;
}

test('1 msg + @lid → not_lead + tag fragmento_backfill, ator sistema', async () => {
  await msg('12345@lid', 1);
  const r = await markBackfillFragments(pool, 1, 'ws-1');
  assert.equal(r.marked, 1);
  assert.equal((await meta('12345@lid')).is_lead, false);
  assert.equal((await meta('12345@lid')).updated_by, 'system:backfill');
  assert.equal(await hasTag('12345@lid'), true);
});

test('1 msg com número real → NÃO marca; @lid com 2 msgs → NÃO marca', async () => {
  await msg('+5531999', 1);        // número real, 1 msg
  await msg('67890@lid', 2);       // @lid, 2 msgs
  const r = await markBackfillFragments(pool, 1, 'ws-1');
  assert.equal(r.marked, 0);
  assert.equal(await meta('+5531999'), null);
  assert.equal(await meta('67890@lid'), null);
});

test('não sobrescreve thread_meta existente + idempotente', async () => {
  await msg('12345@lid', 1);
  await pool.query(`INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead, updated_by) VALUES (1,'12345@lid',TRUE,'user:ana')`);
  const r1 = await markBackfillFragments(pool, 1, 'ws-1');
  assert.equal(r1.marked, 0, 'row existente prevalece');
  assert.equal((await meta('12345@lid')).is_lead, true);
  const r2 = await markBackfillFragments(pool, 1, 'ws-1'); // re-run
  assert.equal(r2.marked, 0, 'idempotente');
});
