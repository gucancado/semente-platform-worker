import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { listThreads } from '../../src/whatsapp/read-queries.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, messages RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('listThreads agrupa por identifier, ordena por last_at desc e pagina por keyset', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (70,'ws-1','i')`);
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
    VALUES (70,'ws-1','whatsapp','+a','inbound','1', NOW() - INTERVAL '2 min'),
           (70,'ws-1','whatsapp','+b','inbound','2', NOW() - INTERVAL '1 min')`);
  const page1 = await listThreads(pool, { workspaceId: 'ws-1', numberId: 70, limit: 1 });
  assert.equal(page1.threads.length, 1);
  assert.equal(page1.threads[0].identifier, '+b'); // mais recente
  assert.ok(page1.nextCursor);
  const page2 = await listThreads(pool, { workspaceId: 'ws-1', numberId: 70, limit: 1, cursor: page1.nextCursor! });
  assert.equal(page2.threads[0].identifier, '+a');
});
