import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';

beforeEach(async () => {
  await pool.query('TRUNCATE webhook_logs RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('messages.agent é nullable e colunas de número existem', async () => {
  const { rows } = await pool.query(
    `SELECT is_nullable FROM information_schema.columns WHERE table_name='messages' AND column_name='agent'`);
  assert.equal(rows[0].is_nullable, 'YES');
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='messages' AND column_name IN ('whatsapp_number_id','workspace_id')`);
  assert.equal(cols.rows.length, 2);
});

test('uq_webhook_logs_evt: mesmo evolution_event_id com agents distintos é bloqueado (dedup global)', async () => {
  await pool.query(
    `INSERT INTO webhook_logs (agent, channel, identifier, evolution_event_id) VALUES ('mercurio','whatsapp','+55','evtX')`);
  // agent diferente, mesmo evt: passa no índice legado (agent,evt) MAS é bloqueado pelo índice global (evt).
  await assert.rejects(
    () => pool.query(`INSERT INTO webhook_logs (agent, channel, identifier, evolution_event_id) VALUES ('saturno','whatsapp','+55','evtX')`),
    /duplicate key|uq_webhook_logs_evt/);
});
