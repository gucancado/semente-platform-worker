// tests/whatsapp/stats-triage.db.test.ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { getStats } from '../../src/whatsapp/stats.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, messages, whatsapp_thread_meta, whatsapp_groups RESTART IDENTITY CASCADE');
  // número 1: exposição OFF
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance, expose_groups_in_mcp) VALUES (1,'ws','i',FALSE)`);

  // DM não-triado, lead (sem meta) → conta na fila
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at) VALUES (1,'ws','whatsapp','dm_novo','inbound','oi',NOW())`);
  // DM lead com stage → NÃO conta na fila
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at) VALUES (1,'ws','whatsapp','dm_qual','inbound','oi',NOW())`);
  await pool.query(`INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead, lead_stage) VALUES (1,'dm_qual',TRUE,'qualificado')`);
  // DM not_lead sem stage → NÃO conta na fila (não é lead)
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at) VALUES (1,'ws','whatsapp','dm_nl','inbound','oi',NOW())`);
  await pool.query(`INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead) VALUES (1,'dm_nl',FALSE)`);
  // GRUPO (tem author) sem stage → NÃO conta na fila; conta em hiddenGroups (exposição off)
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, author, created_at) VALUES (1,'ws','whatsapp','g1@g.us','inbound','oi','+55autor',NOW())`);
});
after(() => pool.end());

test('triage.queue = só DM lead sem stage; hiddenGroups conta grupo de número com exposição off', async () => {
  const stats = await getStats(pool, { workspaceId: 'ws' });
  assert.equal(stats.triage.queue, 1, 'só dm_novo');
  assert.equal(stats.triage.hiddenGroups, 1, 'g1@g.us em número com exposição off');
  assert.ok(typeof stats.triage.note === 'string' && stats.triage.note.length > 0);
  // sanidade: buckets antigos permanecem
  assert.equal(stats.total, 4);
  assert.equal(stats.byStage['null'], 3); // dm_novo + dm_nl + g1 (grupo) — mistura que a fila NÃO usa
});
