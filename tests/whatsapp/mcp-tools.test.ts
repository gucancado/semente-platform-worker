import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { whatsappListNumbersHandler } from '../../src/mcp/tools.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('whatsapp_list_numbers exige workspace_id e devolve números', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (workspace_id, evolution_instance) VALUES ('ws-1','i')`);
  const out = await whatsappListNumbersHandler(pool, { workspace_id: 'ws-1' });
  assert.equal(out.numbers.length, 1);
  await assert.rejects(() => whatsappListNumbersHandler(pool, {} as any), /workspace_id/);
});
