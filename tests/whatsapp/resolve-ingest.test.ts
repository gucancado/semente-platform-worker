import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { resolveIngest } from '../../src/whatsapp/resolve-ingest.js';

const legacyParse = (i: string) => { const h = i.indexOf('-'); return h < 0 ? { agent: i, project: null } : { agent: i.slice(0, h), project: i.slice(h + 1) }; };

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, contact_routes RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('resolve por número quando existe', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, mode) VALUES ('ws-1','inst-1','agent_operated')`);
  const r = await resolveIngest(pool, 'inst-1', { legacyEnabled: true, legacyParse });
  assert.equal(r.source, 'number'); assert.equal(r.workspaceId, 'ws-1'); assert.equal(r.mode, 'agent_operated');
});

test('cai no legado quando número não existe e flag ON (resolve via contact_routes)', async () => {
  await pool.query(`INSERT INTO contact_routes (agent, channel, identifier, workspace_id) VALUES ('mercurio','whatsapp','+55','ws-9')`);
  const r = await resolveIngest(pool, 'mercurio-proj', { legacyEnabled: true, legacyParse });
  assert.equal(r.source, 'legacy'); assert.equal(r.workspaceId, 'ws-9'); assert.equal(r.numberId, null);
});

test('miss quando número ausente e flag OFF', async () => {
  const r = await resolveIngest(pool, 'ghost', { legacyEnabled: false, legacyParse });
  assert.equal(r.source, 'miss');
});
