// tests/whatsapp/stats-triage.db.test.ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { getStats } from '../../src/whatsapp/stats.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, messages, whatsapp_thread_meta, whatsapp_groups, whatsapp_opportunities RESTART IDENTITY CASCADE');
  // número 1: exposição OFF
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance, expose_groups_in_mcp) VALUES (1,'ws','i',FALSE)`);

  // DM não-triado (sem meta, is_lead NULL) COM opp em_andamento → conta na fila (novas_conversas)
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at) VALUES (1,'ws','whatsapp','dm_novo','inbound','oi',NOW())`);
  await pool.query(`INSERT INTO whatsapp_opportunities (whatsapp_number_id, workspace_id, identifier, status, created_by) VALUES (1,'ws','dm_novo','em_andamento','test')`);
  // DM lead (is_lead=TRUE) COM opp em_andamento → NÃO conta na fila (já triado)
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at) VALUES (1,'ws','whatsapp','dm_qual','inbound','oi',NOW())`);
  await pool.query(`INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead) VALUES (1,'dm_qual',TRUE)`);
  await pool.query(`INSERT INTO whatsapp_opportunities (whatsapp_number_id, workspace_id, identifier, status, is_qualified, qualification, created_by) VALUES (1,'ws','dm_qual','em_andamento',TRUE,'qualificado','test')`);
  // DM not_lead sem opp aberta → NÃO conta (não é indefinido)
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at) VALUES (1,'ws','whatsapp','dm_nl','inbound','oi',NOW())`);
  await pool.query(`INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead) VALUES (1,'dm_nl',FALSE)`);
  // GRUPO (tem author) → grupos nunca têm opp; conta em hiddenGroups (exposição off)
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, author, created_at) VALUES (1,'ws','whatsapp','g1@g.us','inbound','oi','+55autor',NOW())`);
});
after(() => pool.end());

test('triage.queue = opps em_andamento de DMs indefinidas (novas_conversas); hiddenGroups conta grupo de número com exposição off', async () => {
  const stats = await getStats(pool, { workspaceId: 'ws' });
  assert.equal(stats.triage.queue, 1, 'só a opp de dm_novo (is_lead NULL)');
  assert.equal(stats.triage.hiddenGroups, 1, 'g1@g.us em número com exposição off');
  assert.ok(typeof stats.triage.note === 'string' && stats.triage.note.length > 0);
  // sanidade: buckets de thread permanecem
  assert.equal(stats.total, 4);
  assert.equal(stats.byStage['null'], 3); // dm_novo + dm_nl + g1 (grupo) — mistura que a fila NÃO usa
  // tri-state: dm_qual=lead, dm_nl=not_lead, dm_novo+g1=indefinido
  assert.equal(stats.byLeadStatus.lead, 1);
  assert.equal(stats.byLeadStatus.not_lead, 1);
  assert.equal(stats.byLeadStatus.indefinido, 2);
});
