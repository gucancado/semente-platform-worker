// tests/whatsapp/lead-filter.db.test.ts  (roda no servidor com DATABASE_URL)
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { listThreads } from '../../src/whatsapp/read-queries.js';
import { setLeadStatus } from '../../src/whatsapp/thread-meta.js';

beforeEach(async () => { await pool.query('TRUNCATE messages, whatsapp_numbers, whatsapp_thread_meta RESTART IDENTITY CASCADE'); });
after(() => pool.end());

test('listThreads filtra not_lead corretamente', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','inst')`);
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at) VALUES (1,'ws','whatsapp','+5531999999999','inbound','oi', NOW())`);
  await setLeadStatus(pool, { numberId: 1, identifier: '+5531999999999', isLead: false, updatedBy: 'test' });
  const all = await listThreads(pool, { workspaceId: 'ws', numberId: 1, limit: 30 });
  assert.equal(all.threads[0].leadStatus, 'not_lead');
  const onlyLeads = await listThreads(pool, { workspaceId: 'ws', numberId: 1, limit: 30, leadStatus: 'lead' });
  assert.equal(onlyLeads.threads.length, 0);
});
