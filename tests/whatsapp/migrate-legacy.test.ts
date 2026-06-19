import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { migrateLegacy } from '../../src/whatsapp/migrate-legacy.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, workspace_agents, messages, webhook_logs, whatsapp_groups, contact_routes RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('materializa instância legada como número + workspace_agent e backfilla messages', async () => {
  await pool.query(`INSERT INTO contact_routes (agent, channel, identifier, workspace_id) VALUES ('mercurio','whatsapp','+55','ws-9')`);
  await pool.query(`INSERT INTO messages (agent, project, channel, identifier, direction, text) VALUES ('mercurio','bluma-cf','whatsapp','+55','inbound','oi')`);
  const agentTokens = { mercurio: { worker_token: 't', fallback_workspace_id: 'ws-9', mode: 'reactive' as const } };

  const report = await migrateLegacy(pool, agentTokens, { dryRun: false });
  assert.equal(report.numbersCreated, 1);
  assert.equal(report.agentsUpserted, 1);
  assert.ok(report.messagesBackfilled >= 1);

  const { rows } = await pool.query(`SELECT whatsapp_number_id, workspace_id FROM messages WHERE agent='mercurio'`);
  assert.ok(rows[0].whatsapp_number_id);
  assert.equal(rows[0].workspace_id, 'ws-9');
  const wa = await pool.query(`SELECT config FROM workspace_agents WHERE agent='mercurio'`);
  assert.equal(wa.rows[0].config.reaction_mode, 'reactive');
  assert.ok(wa.rows[0].config.operates_numbers.length === 1);
});

test('dry-run não escreve', async () => {
  await pool.query(`INSERT INTO messages (agent, project, channel, identifier, direction, text) VALUES ('saturno','x','whatsapp','+1','inbound','y')`);
  const report = await migrateLegacy(pool, { saturno: { worker_token: 't', fallback_workspace_id: 'ws-2', mode: 'sweep' as const } }, { dryRun: true });
  assert.equal((await pool.query(`SELECT count(*) c FROM whatsapp_numbers`)).rows[0].c, '0');
  assert.ok(report.numbersCreated >= 1); // o relatório conta o que FARIA
});
