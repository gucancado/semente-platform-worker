import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { resolveInboundAgent } from '../../src/whatsapp/ingest-persist.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, workspace_agents RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('agent inbound = operador único; NULL se monitored', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance, mode) VALUES (50,'ws-1','i','agent_operated')`);
  await pool.query(`INSERT INTO workspace_agents (workspace_id, agent, config) VALUES ('ws-1','mercurio','{"operates_numbers":[50]}')`);
  assert.equal(await resolveInboundAgent(pool, { workspaceId: 'ws-1', numberId: 50, mode: 'agent_operated' }), 'mercurio');
  assert.equal(await resolveInboundAgent(pool, { workspaceId: 'ws-1', numberId: 50, mode: 'monitored' }), null);
});

test('agent NULL se >1 operador (ambíguo)', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance, mode) VALUES (51,'ws-1','j','agent_operated')`);
  await pool.query(`INSERT INTO workspace_agents (workspace_id, agent, config) VALUES ('ws-1','mercurio','{"operates_numbers":[51]}'),('ws-1','saturno','{"operates_numbers":[51]}')`);
  assert.equal(await resolveInboundAgent(pool, { workspaceId: 'ws-1', numberId: 51, mode: 'agent_operated' }), null);
});
