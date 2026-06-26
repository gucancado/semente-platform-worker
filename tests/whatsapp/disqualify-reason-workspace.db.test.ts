// tests/whatsapp/disqualify-reason-workspace.db.test.ts
//
// Anti-leak proof: a disqualifyReason active only in workspace B MUST NOT be
// accepted for a number belonging to workspace A (single route AND bulk route).
//
// AVISO: requer Postgres real — roda no servidor/CI, não localmente.
// Localmente verificar apenas com `pnpm typecheck`.
//
// RED reasoning (before fix):
//   Old query: WHERE code = $1 AND active = TRUE  (global, no workspace_id)
//   → code 'x' seeded active in wsB would pass the check for a wsA number
//   → single route would return 200 instead of 400 ✗
//   → bulk  route would return 200 instead of 400 ✗
//
// GREEN reasoning (after fix):
//   New query: WHERE workspace_id = $1 AND code = $2 AND active = TRUE
//   → 'x' not present for wsA → rows.length === 0 → validateDisqualifyReason returns false
//   → single route returns 400 "não encontrado ou inativo" ✓
//   → bulk   route returns 400 "invalid disqualifyReason"  ✓
//   Positive control: code seeded in wsA IS accepted (rows.length > 0 → true → 200) ✓

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerWriteRoutes } from '../../src/whatsapp/write-routes.js';
import { validateDisqualifyReason } from '../../src/whatsapp/lead-qualify.js';

const TOKEN = 'tkn-ws-scope';
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };
function buildApp() {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool, panelToken: TOKEN, authz: passAuthz });
  return app;
}

// Workspace identifiers (TEXT) — no foreign-key to workspace table, plain strings.
const WS_A = 'ws-scope-a';
const WS_B = 'ws-scope-b';

// A disqualify reason code that exists ONLY in workspace B (never backfilled into A).
// Using a custom code 'test_wsb_only' that won't collide with the 11 standard defaults.
const CODE_WSB_ONLY = 'test_wsb_only';
// A positive-control code that exists in workspace A.
const CODE_WSA = 'test_wsa_code';

beforeEach(async () => {
  // Truncate in FK-safe order. Messages and thread_meta reference whatsapp_numbers.
  await pool.query(
    'TRUNCATE messages, whatsapp_thread_meta, whatsapp_numbers RESTART IDENTITY CASCADE',
  );
  // Remove our test codes from both workspaces (idempotent cleanup).
  await pool.query(
    `DELETE FROM whatsapp_disqualify_reasons WHERE workspace_id IN ($1, $2) AND code IN ($3, $4)`,
    [WS_A, WS_B, CODE_WSB_ONLY, CODE_WSA],
  );

  // ── Seed numbers ─────────────────────────────────────────────────────────────
  // number 10 belongs to WS_A; number 20 belongs to WS_B
  await pool.query(
    `INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (10, $1, 'inst-a'), (20, $2, 'inst-b')`,
    [WS_A, WS_B],
  );

  // ── Seed disqualify reasons ───────────────────────────────────────────────────
  // CODE_WSB_ONLY: active ONLY in WS_B — the cross-workspace leakage code.
  await pool.query(
    `INSERT INTO whatsapp_disqualify_reasons (workspace_id, code, label, active) VALUES ($1, $2, 'WSB Only', TRUE)`,
    [WS_B, CODE_WSB_ONLY],
  );
  // CODE_WSA: active in WS_A — positive control.
  await pool.query(
    `INSERT INTO whatsapp_disqualify_reasons (workspace_id, code, label, active) VALUES ($1, $2, 'WSA Code', TRUE)`,
    [WS_A, CODE_WSA],
  );

  // ── Seed a thread for the single-route write to target ───────────────────────
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, remote_jid, message_id, timestamp, direction) VALUES (10, 'anti-leak-jid', 'msg-al-1', NOW(), 'inbound')`,
  );
});

after(() => pool.end());

// ─────────────────────────────────────────────────────────────────────────────
// Unit: validateDisqualifyReason workspace scoping
// ─────────────────────────────────────────────────────────────────────────────

test('⚠ validateDisqualifyReason: código ativo em wsB retorna false para wsA', async () => {
  const result = await validateDisqualifyReason(pool, WS_A, CODE_WSB_ONLY);
  assert.equal(result, false, `${CODE_WSB_ONLY} não deve ser válido para ${WS_A}`);
});

test('⚠ validateDisqualifyReason: código ativo em wsA retorna true para wsA (controle positivo)', async () => {
  const result = await validateDisqualifyReason(pool, WS_A, CODE_WSA);
  assert.equal(result, true, `${CODE_WSA} deve ser válido para ${WS_A}`);
});

test('⚠ validateDisqualifyReason: código ativo em wsB retorna true para wsB', async () => {
  const result = await validateDisqualifyReason(pool, WS_B, CODE_WSB_ONLY);
  assert.equal(result, true, `${CODE_WSB_ONLY} deve ser válido para ${WS_B}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Single route: /whatsapp/threads/:identifier/lead
// ─────────────────────────────────────────────────────────────────────────────

test('⚠ single route: disqualifyReason ativo só em wsB → 400 para número de wsA (anti-vazamento)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/anti-leak-jid/lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'tester' },
    payload: { number_id: 10, status: 'not_lead', disqualifyReason: CODE_WSB_ONLY },
  });
  assert.equal(res.statusCode, 400, `esperava 400, obteve ${res.statusCode}: ${res.body}`);
  assert.ok(
    res.json().error.includes('não encontrado ou inativo'),
    `erro esperado "não encontrado ou inativo", obteve: ${res.json().error}`,
  );
  await app.close();
});

test('⚠ single route: disqualifyReason ativo em wsA → 200 para número de wsA (controle positivo)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/anti-leak-jid/lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'tester' },
    payload: { number_id: 10, status: 'not_lead', stage: 'desqualificado', disqualifyReason: CODE_WSA },
  });
  assert.equal(res.statusCode, 200, `esperava 200, obteve ${res.statusCode}: ${res.body}`);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Bulk route: /whatsapp/threads/bulk-lead
// ─────────────────────────────────────────────────────────────────────────────

test('⚠ bulk route: disqualifyReason ativo só em wsB → 400 para número de wsA (anti-vazamento)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'tester' },
    payload: {
      number_id: 10,
      updates: [
        { identifier: 'anti-leak-jid', status: 'not_lead', disqualifyReason: CODE_WSB_ONLY },
      ],
    },
  });
  assert.equal(res.statusCode, 400, `esperava 400, obteve ${res.statusCode}: ${res.body}`);
  const body = res.json();
  assert.equal(body.error, 'invalid disqualifyReason', `erro esperado "invalid disqualifyReason", obteve: ${body.error}`);
  assert.deepEqual(body.invalidReasons, [CODE_WSB_ONLY]);
  await app.close();
});

test('⚠ bulk route: disqualifyReason ativo em wsA → 200 para número de wsA (controle positivo)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'tester' },
    payload: {
      number_id: 10,
      updates: [
        { identifier: 'anti-leak-jid', status: 'not_lead', stage: 'desqualificado', disqualifyReason: CODE_WSA },
      ],
    },
  });
  assert.equal(res.statusCode, 200, `esperava 200, obteve ${res.statusCode}: ${res.body}`);
  await app.close();
});

test('⚠ bulk route: mix de reasons — um de wsB e um de wsA → 400 lista ambos inválidos para wsA', async () => {
  // CODE_WSB_ONLY is from wsB; also test a completely unknown code.
  const CODE_UNKNOWN = 'completely_unknown_xyz';
  await pool.query(
    `DELETE FROM whatsapp_disqualify_reasons WHERE workspace_id = $1 AND code = $2`,
    [WS_A, CODE_UNKNOWN],
  );

  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'tester' },
    payload: {
      number_id: 10,
      updates: [
        { identifier: 'anti-leak-jid', status: 'not_lead', disqualifyReason: CODE_WSB_ONLY },
        { identifier: 'anti-leak-jid-2', status: 'not_lead', disqualifyReason: CODE_UNKNOWN },
      ],
    },
  });
  // Both identifiers are missing in DB for number 10 — but the reason validation
  // runs before the identifier resolution, so we still get 400 for invalid reasons.
  assert.equal(res.statusCode, 400, `esperava 400, obteve ${res.statusCode}: ${res.body}`);
  const body = res.json();
  assert.equal(body.error, 'invalid disqualifyReason');
  // Both should be reported as invalid for wsA.
  assert.ok(
    body.invalidReasons.includes(CODE_WSB_ONLY),
    `${CODE_WSB_ONLY} deve aparecer em invalidReasons`,
  );
  assert.ok(
    body.invalidReasons.includes(CODE_UNKNOWN),
    `${CODE_UNKNOWN} deve aparecer em invalidReasons`,
  );
  await app.close();
});
