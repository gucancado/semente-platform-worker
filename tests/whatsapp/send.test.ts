import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { whatsappSend } from '../../src/whatsapp/send.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, workspace_agents, channel_locks, messages RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('recusa se agente não opera o número', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance, mode) VALUES (80,'ws-1','i80','agent_operated')`);
  const deps = { pool, evolution: { baseUrl: 'x', apiKey: 'k', fetch: (async () => ({ ok: true, status: 200, json: async () => ({ key: { id: 'S1' } }) })) as any } };
  await assert.rejects(() => whatsappSend(deps, { agent: 'mercurio', workspaceId: 'ws-1', numberId: 80, identifier: '+55', text: 'oi' }), /not an operator/);
});

test('envia e registra messages outbound quando operador + lock livre', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance, mode) VALUES (81,'ws-1','i81','agent_operated')`);
  await pool.query(`INSERT INTO workspace_agents (workspace_id, agent, config) VALUES ('ws-1','mercurio','{"operates_numbers":[81]}')`);
  let sent = false;
  const deps = { pool, evolution: { baseUrl: 'x', apiKey: 'k', fetch: (async () => { sent = true; return { ok: true, status: 200, json: async () => ({ key: { id: 'S2' } }) }; }) as any } };
  const r = await whatsappSend(deps, { agent: 'mercurio', workspaceId: 'ws-1', numberId: 81, identifier: '+55', text: 'oi' });
  assert.equal(r.sendId, 'S2'); assert.equal(sent, true);
  const { rows } = await pool.query(`SELECT direction, agent FROM messages WHERE whatsapp_number_id=81 AND direction='outbound'`);
  assert.equal(rows[0].agent, 'mercurio');
});
