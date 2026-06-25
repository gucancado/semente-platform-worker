/**
 * tests/whatsapp/bulk-lead.test.ts
 *
 * Tests for POST /whatsapp/threads/bulk-lead.
 *
 * DB-FREE cases (marked ✓ — run locally with node --test):
 *   These fire before any DB call; inject PANIC_POOL / fake authz.
 *
 * SERVER-GATED cases (marked ⚠ NEEDS POSTGRES):
 *   Require a real DB (transactions, identifier-existence, upserts, meta_log).
 *   Listed here for completeness; skipped locally via DATABASE_URL absence guard.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthzError } from '../../src/whatsapp/authz.js';
import { registerWriteRoutes } from '../../src/whatsapp/write-routes.js';
import type { RouteAuthz } from '../../src/whatsapp/route-authz.js';
import { BULK_LEAD_MAX } from '../../src/whatsapp/bulk-lead.js';

// ── Fake pool: panics if any DB query is executed ─────────────────────────────
const PANIC_POOL = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'query') {
        return () => Promise.reject(new Error('DB should not be reached before validation/authz'));
      }
      return undefined;
    },
  },
) as any;

// ── Fake pool that resolves a number row (for authz-gate tests) ───────────────
function makeNumberPool(workspaceId: string) {
  return {
    query: async (sql: string, params: any[]) => {
      if (sql.includes('FROM whatsapp_numbers') && sql.includes('WHERE id =')) {
        return {
          rows: [{
            id: params[0],
            workspace_id: workspaceId,
            phone: null,
            evolution_instance: 'test-i',
            label: null,
            status: 'connected',
            mode: 'monitored',
            expose_groups_in_mcp: false,
            created_by: null,
            created_at: new Date(),
            updated_at: new Date(),
          }],
        };
      }
      throw new Error(`Unexpected DB call in makeNumberPool: ${sql}`);
    },
  } as any;
}

// ── Authz factories ───────────────────────────────────────────────────────────

function makeAdminForbidden(): RouteAuthz & { adminCalls: number } {
  return {
    adminCalls: 0,
    async assertMember() { /* pass */ },
    async assertAdmin(_u, _w) {
      this.adminCalls++;
      throw new AuthzError('forbidden', 'FORBIDDEN');
    },
  };
}

function makeAllPass(): RouteAuthz {
  return {
    async assertMember() { /* pass */ },
    async assertAdmin() { /* pass */ },
  };
}

const PANEL_TOKEN = 'test-panel';
const PANEL_HEADERS = { 'x-panel-token': PANEL_TOKEN };
const ACTOR_HEADERS = { 'x-panel-token': PANEL_TOKEN, 'x-acting-user': 'user-abc' };

const VALID_UPDATE = { identifier: 'c-1', status: 'lead' };

// =============================================================================
// DB-FREE TESTS ✓
// =============================================================================

// ── (1) actor absent → 400 ───────────────────────────────────────────────────
test('✓ bulk-lead: actor absent → 400, no DB call', async () => {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: makeAllPass() });

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: PANEL_HEADERS, // no x-acting-user
    payload: { number_id: 1, updates: [VALID_UPDATE] },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'x-acting-user required');
  await app.close();
});

// ── (2) non-admin → 403, NO bulk write ───────────────────────────────────────
test('✓ bulk-lead: non-admin (assertAdmin throws FORBIDDEN) → 403, no write', async () => {
  const spy = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: makeNumberPool('ws-1'), panelToken: PANEL_TOKEN, authz: spy });

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: ACTOR_HEADERS,
    payload: { number_id: 1, updates: [VALID_UPDATE] },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(spy.adminCalls, 1, 'assertAdmin must be called exactly once');
  await app.close();
});

// ── (3) invalid status in an update → 400 ────────────────────────────────────
test('✓ bulk-lead: invalid status in update → 400, no DB call', async () => {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: makeAllPass() });

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: ACTOR_HEADERS,
    payload: { number_id: 1, updates: [{ identifier: 'c-1', status: 'maybe' }] },
  });

  assert.equal(res.statusCode, 400);
  assert.ok(res.json().error.includes('status must be'));
  await app.close();
});

// ── (4a) non-array updates → 400 ─────────────────────────────────────────────
test('✓ bulk-lead: non-array updates → 400, no DB call', async () => {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: makeAllPass() });

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: ACTOR_HEADERS,
    payload: { number_id: 1, updates: 'not-an-array' },
  });

  assert.equal(res.statusCode, 400);
  assert.ok(res.json().error.includes('non-empty array'));
  await app.close();
});

// ── (4b) empty updates array → 400 ───────────────────────────────────────────
test('✓ bulk-lead: empty updates array → 400, no DB call', async () => {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: makeAllPass() });

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: ACTOR_HEADERS,
    payload: { number_id: 1, updates: [] },
  });

  assert.equal(res.statusCode, 400);
  assert.ok(res.json().error.includes('non-empty array'));
  await app.close();
});

// ── (5) non-array tags in an update → 400 ────────────────────────────────────
test('✓ bulk-lead: non-array tags in update → 400, no DB call', async () => {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: makeAllPass() });

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: ACTOR_HEADERS,
    payload: { number_id: 1, updates: [{ identifier: 'c-1', status: 'lead', tags: 'vip' }] },
  });

  assert.equal(res.statusCode, 400);
  assert.ok(res.json().error.includes('tags must be an array of strings'));
  await app.close();
});

// ── (5b) array of non-strings in tags → 400 ──────────────────────────────────
test('✓ bulk-lead: tags=[1,2] (array of non-strings) → 400, no DB call', async () => {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: makeAllPass() });

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: ACTOR_HEADERS,
    payload: { number_id: 1, updates: [{ identifier: 'c-1', status: 'lead', tags: [1, 2] }] },
  });

  assert.equal(res.statusCode, 400);
  assert.ok(res.json().error.includes('tags must be an array of strings'));
  await app.close();
});

// ── (6) updates.length > 500 → 400 ───────────────────────────────────────────
test(`✓ bulk-lead: updates.length > ${BULK_LEAD_MAX} → 400, no DB call`, async () => {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: makeAllPass() });

  const bigUpdates = Array.from({ length: BULK_LEAD_MAX + 1 }, (_, i) => ({
    identifier: `c-${i}`,
    status: 'lead' as const,
  }));

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: ACTOR_HEADERS,
    payload: { number_id: 1, updates: bigUpdates },
  });

  assert.equal(res.statusCode, 400);
  assert.ok(res.json().error.includes(`${BULK_LEAD_MAX}`));
  await app.close();
});

// ── (7) missing number_id → 400 ──────────────────────────────────────────────
test('✓ bulk-lead: missing number_id → 400, no DB call', async () => {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: makeAllPass() });

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: ACTOR_HEADERS,
    payload: { updates: [VALID_UPDATE] },
  });

  assert.equal(res.statusCode, 400);
  assert.ok(res.json().error.toLowerCase().includes('number_id'));
  await app.close();
});

// ── (8) non-numeric number_id → 400 ──────────────────────────────────────────
test('✓ bulk-lead: non-numeric number_id → 400, no DB call', async () => {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: makeAllPass() });

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: ACTOR_HEADERS,
    payload: { number_id: 'abc', updates: [VALID_UPDATE] },
  });

  assert.equal(res.statusCode, 400);
  assert.ok(res.json().error.toLowerCase().includes('numeric'));
  await app.close();
});

// ── (9) stage coherence failure → 400 ────────────────────────────────────────
test('✓ bulk-lead: stage=desqualificado with status=lead → 400 (coherence), no DB call', async () => {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: makeAllPass() });

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: ACTOR_HEADERS,
    payload: { number_id: 1, updates: [{ identifier: 'c-1', status: 'lead', stage: 'desqualificado' }] },
  });

  assert.equal(res.statusCode, 400);
  assert.ok(res.json().error.includes('desqualificado'));
  await app.close();
});

// ── (10) invalid stage value → 400 ───────────────────────────────────────────
test('✓ bulk-lead: invalid stage value → 400, no DB call', async () => {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: makeAllPass() });

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: ACTOR_HEADERS,
    payload: { number_id: 1, updates: [{ identifier: 'c-1', status: 'lead', stage: 'interessado' }] },
  });

  assert.equal(res.statusCode, 400);
  assert.ok(res.json().error.includes('stage inválido'));
  await app.close();
});

// ── (10b) duplicate identifiers in updates[] → 400 (pure, before gate) ───────
test('✓ bulk-lead: duplicate identifiers → 400, no DB call', async () => {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: makeAllPass() });

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: ACTOR_HEADERS,
    payload: {
      number_id: 1,
      updates: [
        { identifier: 'c-1', status: 'lead' },
        { identifier: 'c-2', status: 'not_lead' },
        { identifier: 'c-1', status: 'not_lead' }, // duplicate of c-1
      ],
    },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'duplicate identifiers');
  assert.deepEqual(res.json().duplicates, ['c-1']);
  await app.close();
});

// ── (11) number not found → 404 (actor check + pure validation pass, getNumber returns empty) ─
test('✓ bulk-lead: number not found → 404', async () => {
  const emptyPool = {
    query: async () => ({ rows: [] }),
  } as any;
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: emptyPool, panelToken: PANEL_TOKEN, authz: makeAllPass() });

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: ACTOR_HEADERS,
    payload: { number_id: 999, updates: [VALID_UPDATE] },
  });

  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'number not found');
  await app.close();
});

// =============================================================================
// SERVER-GATED TESTS ⚠ NEEDS POSTGRES
// (listed here for documentation; these require a real DB and cannot run locally)
// =============================================================================

// ⚠ NEEDS POSTGRES: all-or-nothing — unknown identifier aborts entire transaction
//   Setup: insert whatsapp_number, insert message for identifier 'c-known', attempt
//   bulk update of ['c-known', 'c-unknown']. Expect 400 with unknownIdentifiers=['c-unknown'].
//   Verify: no whatsapp_thread_meta rows written for 'c-known' (transaction rolled back).

// ⚠ NEEDS POSTGRES: successful bulk update — all identifiers exist
//   Setup: insert number, insert messages for c-1 and c-2, POST bulk-lead with both.
//   Expect 200 with { updated: 2, identifiers: ['c-1', 'c-2'] }.
//   Verify: whatsapp_thread_meta rows exist for both with correct is_lead, updated_by.
//   Verify: whatsapp_thread_meta_log entries created for both.

// ⚠ NEEDS POSTGRES: existing thread_meta row counts as existing identifier
//   Setup: insert number, insert thread_meta row for c-meta WITHOUT a messages row.
//   Verify that bulk update accepts c-meta (existence via thread_meta, not just messages).

// ⚠ NEEDS POSTGRES: tags are replaced (not merged) within the transaction
//   Setup: pre-existing tags for c-1, bulk update with new tags=['vip'].
//   Verify: only 'vip' tag remains after update.

// ⚠ NEEDS POSTGRES: disqualifyReason validation runs after authz gate
//   Setup: valid admin, number exists, update with unknown disqualifyReason.
//   Expect 400 with appropriate error message; no rows written.
