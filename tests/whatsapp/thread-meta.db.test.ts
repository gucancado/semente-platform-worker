// tests/whatsapp/thread-meta.db.test.ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { setLeadStatus, setGroupExposure, getNumberExposure, isGroupThread } from '../../src/whatsapp/thread-meta.js';

beforeEach(async () => { await pool.query('TRUNCATE messages, whatsapp_numbers, whatsapp_thread_meta, whatsapp_groups RESTART IDENTITY CASCADE'); });
after(() => pool.end());

test('setLeadStatus upsert + reversão', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
  await setLeadStatus(pool, { numberId: 1, identifier: 'c', isLead: false, updatedBy: 'u1' });
  let r = await pool.query(`SELECT is_lead FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier='c'`);
  assert.equal(r.rows[0].is_lead, false);
  await setLeadStatus(pool, { numberId: 1, identifier: 'c', isLead: true, updatedBy: 'u2' });
  r = await pool.query(`SELECT is_lead, updated_by FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier='c'`);
  assert.equal(r.rows[0].is_lead, true);
  assert.equal(r.rows[0].updated_by, 'u2');
});

test('setGroupExposure + getNumberExposure', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
  assert.equal(await getNumberExposure(pool, 1), false);
  await setGroupExposure(pool, { numberId: 1, expose: true });
  assert.equal(await getNumberExposure(pool, 1), true);
});

test('isGroupThread: author presente OR whatsapp_groups.jid', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, identifier, author, direction, text, created_at) VALUES (1,'ws','g@g.us','+55','inbound','x',NOW())`);
  assert.equal(await isGroupThread(pool, 1, 'g@g.us'), true);
  assert.equal(await isGroupThread(pool, 1, 'dm'), false);
});
