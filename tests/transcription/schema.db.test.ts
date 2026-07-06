import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';

after(() => pool.end());

test('messages ganhou colunas de mídia', async () => {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='messages' AND column_name = ANY($1)`,
    [['kind','media_key','media_mime','media_duration_s','transcription_status']]);
  assert.equal(rows.length, 5);
});

test('transcription_jobs existe com unique por (number, evento)', async () => {
  const { rows } = await pool.query(`SELECT to_regclass('transcription_jobs') AS t`);
  assert.equal(rows[0].t, 'transcription_jobs');
  const { rows: idx } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename='transcription_jobs' AND indexname='uq_transcription_jobs_evt'`);
  assert.equal(idx.length, 1);
});

test('kind CHECK rejeita valor inválido', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (900,'ws-t1','inst-t1') ON CONFLICT DO NOTHING`);
  await assert.rejects(
    pool.query(`INSERT INTO messages (channel, identifier, direction, text, kind, whatsapp_number_id) VALUES ('whatsapp','+1','inbound','x','video',900)`),
    /messages_kind_chk/);
});
