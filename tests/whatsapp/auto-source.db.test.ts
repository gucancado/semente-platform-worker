import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { seedDefaultSourceSignals, detectAndTagSource } from '../../src/whatsapp/source-signals.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_source_signals, whatsapp_thread_meta, whatsapp_access_log, whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1, 'ws-1', 'inst-1')`);
  await seedDefaultSourceSignals(pool, 'ws-1');
});
after(() => pool.end());

async function metaSource(identifier: string) {
  const { rows } = await pool.query(`SELECT lead_source, is_lead, updated_by FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier=$1`, [identifier]);
  return rows[0] ?? null;
}

test('casa "vim pelo site" → lead_source=site, is_lead default TRUE, ator sistema, auto_source logado', async () => {
  const r = await detectAndTagSource(pool, { workspaceId: 'ws-1', numberId: 1, identifier: '+55a', text: 'Olá! Vim pelo site' });
  assert.deepEqual(r, { source: 'site' });
  const m = await metaSource('+55a');
  assert.equal(m.lead_source, 'site'); assert.equal(m.is_lead, true); assert.equal(m.updated_by, 'system:ingest');
  const { rows } = await pool.query(`SELECT 1 FROM whatsapp_access_log WHERE action='auto_source' AND identifier='+55a'`);
  assert.equal(rows.length, 1);
});

test('sem match → nenhuma row criada', async () => {
  const r = await detectAndTagSource(pool, { workspaceId: 'ws-1', numberId: 1, identifier: '+55b', text: 'quero um orçamento' });
  assert.equal(r, null);
  assert.equal(await metaSource('+55b'), null);
});

test('não sobrescreve lead_source já setado (humano prevalece)', async () => {
  await pool.query(`INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, lead_source, updated_by) VALUES (1,'+55c','indicacao','user:ana')`);
  const r = await detectAndTagSource(pool, { workspaceId: 'ws-1', numberId: 1, identifier: '+55c', text: 'Vim pelo site' });
  assert.equal(r, null, 'não regrava quando já há source');
  const m = await metaSource('+55c');
  assert.equal(m.lead_source, 'indicacao'); assert.equal(m.updated_by, 'user:ana');
});
