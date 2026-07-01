/**
 * tests/whatsapp/bulk-lead-route-partial.db.test.ts
 *
 * SERVER-GATED (Postgres efêmero).
 * Testa o handler POST /whatsapp/threads/bulk-lead com mode='partial' numa
 * requisição HTTP real (via app.inject), exercitando o lote misto:
 *   +a   → válido, reason válido  → updated
 *   +b   → reason inválido        → skipped (invalid_reason)
 *   +ghost → não existe           → skipped (unknown_identifier)
 *   +dup × 2 → duplicata          → skipped (duplicate) ambas
 *   +bad → status inválido        → skipped (invalid_field)
 *
 * Assert principal: updated=1 (+a), skipped.length=5, +a persistido no DB.
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerWriteRoutes } from '../../src/whatsapp/write-routes.js';

const TOKEN = 'tkn-partial';
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };

function buildApp() {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool, panelToken: TOKEN, authz: passAuthz });
  return app;
}

beforeEach(async () => {
  await pool.query('TRUNCATE messages, whatsapp_thread_meta, whatsapp_numbers, whatsapp_disqualify_reasons RESTART IDENTITY CASCADE');
  // Inserir número
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1, 'ws-1', 'inst-1')`);
  // Inserir 2 threads existentes (+a, +b)
  await pool.query(`
    INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, ingest_source)
    VALUES
      (1, 'ws-1', 'whatsapp', '+a', 'inbound', 'msg-a', 'live'),
      (1, 'ws-1', 'whatsapp', '+b', 'inbound', 'msg-b', 'live')
  `);
  // Inserir 1 reason ativo
  await pool.query(`INSERT INTO whatsapp_disqualify_reasons (workspace_id, code, label, active, created_by) VALUES ('ws-1', 'sem_interesse', 'Sem interesse', TRUE, '00000000-0000-0000-0000-000000000001')`);
});

after(() => pool.end());

test('partial lote misto: updated=1 (+a), 5 skips distribuídos por reason', async () => {
  const app = buildApp();

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'tester' },
    payload: {
      number_id: 1,
      mode: 'partial',
      updates: [
        { identifier: '+a',    status: 'not_lead', disqualifyReason: 'sem_interesse' }, // válido
        { identifier: '+b',    status: 'not_lead', disqualifyReason: 'motivo_inexistente' }, // invalid_reason
        { identifier: '+ghost', status: 'lead' },                                            // unknown_identifier
        { identifier: '+dup',  status: 'lead' },                                             // duplicate (1ª)
        { identifier: '+dup',  status: 'not_lead' },                                         // duplicate (2ª)
        { identifier: '+bad',  status: 'BAD_STATUS' as any },                                // invalid_field
      ],
    },
  });

  assert.equal(res.statusCode, 200, `esperado 200, got ${res.statusCode}: ${res.body}`);
  const b = res.json();

  assert.equal(b.ok, true);
  assert.equal(b.mode, 'partial');
  assert.equal(b.updated, 1, 'apenas +a deve ser aplicado');
  assert.deepEqual(b.identifiers, ['+a']);

  // 5 skips esperados
  assert.equal(b.skipped.length, 5, `esperado 5 skips, got ${b.skipped.length}: ${JSON.stringify(b.skipped)}`);

  const byId = (id: string) => b.skipped.filter((s: any) => s.identifier === id);
  const byReason = (r: string) => b.skipped.filter((s: any) => s.reason === r);

  assert.equal(byId('+b').length, 1);
  assert.equal(byId('+b')[0].reason, 'invalid_reason');

  assert.equal(byId('+ghost').length, 1);
  assert.equal(byId('+ghost')[0].reason, 'unknown_identifier');

  const dupSkips = byReason('duplicate');
  assert.equal(dupSkips.length, 2, 'ambas ocorrências de +dup em skipped:duplicate');
  assert.ok(dupSkips.every((s: any) => s.identifier === '+dup'));

  assert.equal(byId('+bad').length, 1);
  assert.equal(byId('+bad')[0].reason, 'invalid_field');

  // Verificar que +a foi persistido no DB
  const meta = await pool.query(
    `SELECT is_lead, disqualify_reason FROM whatsapp_thread_meta WHERE whatsapp_number_id = 1 AND identifier = '+a'`,
  );
  assert.equal(meta.rows.length, 1, '+a deve ter thread_meta persistido');
  assert.equal(meta.rows[0].is_lead, false);
  assert.equal(meta.rows[0].disqualify_reason, 'sem_interesse');

  await app.close();
});
