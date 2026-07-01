/** SERVER-GATED (Postgres efêmero). */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { bulkSetLeadStatus, BulkLeadIdentifierError } from '../../src/whatsapp/bulk-lead.js';

beforeEach(async () => {
  await pool.query('TRUNCATE messages, whatsapp_thread_meta, whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws-1','inst-1')`);
  await pool.query(`INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, ingest_source) VALUES (1,'ws-1','whatsapp','+ok','inbound','m','live')`);
});
after(() => pool.end());

test('partial: unknown identifier vira skipped; o existente é aplicado', async () => {
  const r = await bulkSetLeadStatus(pool, {
    numberId: 1, workspaceId: 'ws-1', updatedBy: 'u', mode: 'partial',
    updates: [
      { identifier: '+ok', status: 'lead', stage: 'qualificado' },
      { identifier: '+ghost', status: 'lead' },
    ],
  });
  assert.equal(r.updated, 1);
  assert.deepEqual(r.identifiers, ['+ok']);
  assert.deepEqual(r.skipped, [{ identifier: '+ghost', reason: 'unknown_identifier' }]);
});

test('partial: todos unknown → updated 0, sem transação, skipped preenchido', async () => {
  const r = await bulkSetLeadStatus(pool, {
    numberId: 1, workspaceId: 'ws-1', updatedBy: 'u', mode: 'partial',
    updates: [{ identifier: '+ghost', status: 'lead' }],
  });
  assert.equal(r.updated, 0);
  assert.deepEqual(r.identifiers, []);
  assert.equal(r.skipped.length, 1);
});

test('strict (default): unknown ainda lança BulkLeadIdentifierError; skipped=[] no sucesso', async () => {
  await assert.rejects(
    () => bulkSetLeadStatus(pool, { numberId: 1, workspaceId: 'ws-1', updatedBy: 'u', updates: [{ identifier: '+ghost', status: 'lead' }] }),
    (e: any) => e instanceof BulkLeadIdentifierError,
  );
  const ok = await bulkSetLeadStatus(pool, { numberId: 1, workspaceId: 'ws-1', updatedBy: 'u', updates: [{ identifier: '+ok', status: 'lead' }] });
  assert.deepEqual(ok, { updated: 1, identifiers: ['+ok'], skipped: [] });
});
