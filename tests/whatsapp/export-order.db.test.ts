// tests/whatsapp/export-order.db.test.ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { exportConversation } from '../../src/whatsapp/export.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, messages RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
  // 5 mensagens cronológicas m1..m5
  for (let i = 1; i <= 5; i++) {
    await pool.query(
      `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
       VALUES (1,'ws','whatsapp','c1','inbound',$1, NOW() + ($2 || ' seconds')::interval)`,
      [`m${i}`, String(i)]);
  }
});
after(() => pool.end());

test("order='tail' (default) mantém as mais RECENTES quando trunca", async () => {
  const out = await exportConversation(pool, { workspaceId: 'ws', numberId: 1, identifier: 'c1', maxMessages: 2 });
  assert.equal(out.truncated, true);
  assert.equal(out.messageCount, 2);
  assert.match(out.transcript, /m4/);
  assert.match(out.transcript, /m5/);
  assert.doesNotMatch(out.transcript, /m1/);
});

test("order='head' mantém as mais ANTIGAS quando trunca", async () => {
  const out = await exportConversation(pool, { workspaceId: 'ws', numberId: 1, identifier: 'c1', maxMessages: 2, order: 'head' });
  assert.equal(out.truncated, true);
  assert.equal(out.messageCount, 2);
  assert.match(out.transcript, /m1/);
  assert.match(out.transcript, /m2/);
  assert.doesNotMatch(out.transcript, /m5/);
});

test('sem truncar, os dois modos trazem as 5 em ordem cronológica', async () => {
  for (const order of ['head', 'tail'] as const) {
    const out = await exportConversation(pool, { workspaceId: 'ws', numberId: 1, identifier: 'c1', maxMessages: 50, order });
    assert.equal(out.messageCount, 5);
    assert.equal(out.truncated, false);
    assert.ok(out.transcript.indexOf('m1') < out.transcript.indexOf('m5'), `ordem cronológica (${order})`);
  }
});
