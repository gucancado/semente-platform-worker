import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { agentsToTrigger, quarantineUnknownInstance } from '../../src/whatsapp/reaction.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, workspace_agents, webhook_receipts RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('só dispara agentes reactive que operam o número; monitored não dispara', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance, mode) VALUES (60,'ws-1','i','agent_operated')`);
  await pool.query(`INSERT INTO workspace_agents (workspace_id, agent, config) VALUES ('ws-1','mercurio','{"reaction_mode":"reactive","operates_numbers":[60]}'),('ws-1','saturno','{"reaction_mode":"sweep","operates_numbers":[60]}')`);
  assert.deepEqual(await agentsToTrigger(pool, { workspaceId: 'ws-1', numberId: 60, mode: 'agent_operated' }), ['mercurio']);
  assert.deepEqual(await agentsToTrigger(pool, { workspaceId: 'ws-1', numberId: 60, mode: 'monitored' }), []);
});

test('quarentena grava webhook_receipts failed e é idempotente', async () => {
  await quarantineUnknownInstance(pool, { event: 'messages.upsert', instance: 'ghost', data: { key: { id: 'E1' } } });
  await quarantineUnknownInstance(pool, { event: 'messages.upsert', instance: 'ghost', data: { key: { id: 'E1' } } });
  const { rows } = await pool.query(`SELECT status FROM webhook_receipts WHERE provider='evolution' AND external_event_id='E1'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
});
