// tests/whatsapp/search-threads.db.test.ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { searchThreads } from '../../src/whatsapp/read-queries.js';

beforeEach(async () => { await pool.query('TRUNCATE messages, whatsapp_numbers, whatsapp_groups, whatsapp_thread_meta RESTART IDENTITY CASCADE'); });
after(() => pool.end());

test('searchThreads agrupa por identifier e conta matches', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, identifier, direction, text, created_at) VALUES
    (1,'ws','c1','inbound','quero orçamento', NOW()),
    (1,'ws','c1','inbound','orçamento urgente', NOW()),
    (1,'ws','c2','inbound','bom dia', NOW())`);
  const { results } = await searchThreads(pool, { workspaceId: 'ws', numberId: 1, query: 'orçamento' });
  assert.equal(results.length, 1);
  assert.equal(results[0].identifier, 'c1');
  assert.equal(results[0].matchCount, 2);
});
