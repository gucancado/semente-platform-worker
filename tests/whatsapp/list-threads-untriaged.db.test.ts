// tests/whatsapp/list-threads-untriaged.db.test.ts (roda no servidor com DATABASE_URL)
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { listThreads } from '../../src/whatsapp/read-queries.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, messages, whatsapp_thread_meta RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
  // 3 threads DM: c_none (sem meta → stage null), c_meta_null (meta sem stage), c_qual (stage qualificado)
  for (const id of ['c_none', 'c_meta_null', 'c_qual']) {
    await pool.query(
      `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
       VALUES (1,'ws','whatsapp',$1,'inbound','oi', NOW())`, [id]);
  }
  await pool.query(`INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead) VALUES (1,'c_meta_null',TRUE)`);
  await pool.query(`INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead, lead_stage) VALUES (1,'c_qual',TRUE,'qualificado')`);
});
after(() => pool.end());

test("lead_stage='none' devolve só threads sem stage (meta ausente ou lead_stage NULL)", async () => {
  const { threads } = await listThreads(pool, { workspaceId: 'ws', numberId: 1, limit: 50, leadStage: 'none' });
  const ids = threads.map((t) => t.identifier).sort();
  assert.deepEqual(ids, ['c_meta_null', 'c_none']);
});

test("lead_stage='qualificado' continua exato (não afetado pela sentinela)", async () => {
  const { threads } = await listThreads(pool, { workspaceId: 'ws', numberId: 1, limit: 50, leadStage: 'qualificado' });
  assert.deepEqual(threads.map((t) => t.identifier), ['c_qual']);
});

test('sem leadStage = todas as threads', async () => {
  const { threads } = await listThreads(pool, { workspaceId: 'ws', numberId: 1, limit: 50 });
  assert.equal(threads.length, 3);
});
