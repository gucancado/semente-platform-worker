import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';

after(() => pool.end());

test('whatsapp_groups ganhou colunas de número/workspace', async () => {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='whatsapp_groups' AND column_name IN ('whatsapp_number_id','workspace_id')`);
  assert.equal(rows.length, 2);
});
