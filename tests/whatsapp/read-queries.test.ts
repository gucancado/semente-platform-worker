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

test('keyset não pula threads com last_at idêntico (desempate por identifier)', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (71,'ws-1','i')`);
  // +b e +c compartilham o MESMO created_at (empate em last_at); +a é mais antigo
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at) VALUES
    (71,'ws-1','whatsapp','+a','inbound','1', TIMESTAMPTZ '2026-01-01 10:00:00+00'),
    (71,'ws-1','whatsapp','+b','inbound','2', TIMESTAMPTZ '2026-01-01 10:05:00+00'),
    (71,'ws-1','whatsapp','+c','inbound','3', TIMESTAMPTZ '2026-01-01 10:05:00+00')`);
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 3; i++) {
    const page = await listThreads(pool, { workspaceId: 'ws-1', numberId: 71, limit: 1, cursor });
    if (!page.threads.length) break;
    seen.push(page.threads[0].identifier);
    cursor = page.nextCursor ?? undefined;
  }
  assert.deepEqual(seen.sort(), ['+a', '+b', '+c']);
});
