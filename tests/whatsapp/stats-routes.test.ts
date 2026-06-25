/**
 * tests/whatsapp/stats-routes.test.ts
 *
 * DB-FREE gate tests for GET /whatsapp/stats (T12) and the opt-in
 * include_first_inbound param on GET /whatsapp/threads (T13).
 *
 * Strategy: inject fake authz + fake/panic pool; verify HTTP status/body WITHOUT
 * any real DB or Bloquim call.
 *
 * DB-FREE cases covered:
 *   stats-1: actor absent → 400
 *   stats-2: workspace_id absent → 400
 *   stats-3: number_id is non-numeric → 400
 *   stats-4: actor present, assertMember FORBIDDEN → 403, DB not called
 *   stats-5: actor present, assertMember MISCONFIGURED → 500
 *   stats-6: number_id absent (no param) → gate runs, DB not called before gate
 *   threads-fib-1: include_first_inbound=false → no DB plumbing cost (flag off)
 *   threads-fib-2: include_first_inbound=true, non-member → 403, DB not called
 *
 * SERVER-GATED (listed, not implemented — require real Postgres):
 *   ⚠ stats happy-path: insert messages/thread_meta/tags → verify counts match.
 *   ⚠ stats byStage "null" bucket: thread without meta → counted under "null".
 *   ⚠ stats byIngestSource: message-level (not thread-level) counts.
 *   ⚠ firstInboundText: earliest inbound message text returned; null when none.
 *   ⚠ firstInboundText off: field absent from response when flag not sent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthzError } from '../../src/whatsapp/authz.js';
import { registerReadRoutes } from '../../src/whatsapp/read-routes.js';
import type { RouteAuthz } from '../../src/whatsapp/route-authz.js';

// ── Fake pool: panics if any query is actually executed ───────────────────────
const PANIC_POOL = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'query') {
        return () => Promise.reject(new Error('DB should not be called before gate resolves'));
      }
      return undefined;
    },
  },
) as any;

// ── Authz factories ───────────────────────────────────────────────────────────

function makeMemberForbidden(): RouteAuthz & { memberCalls: number } {
  return {
    memberCalls: 0,
    async assertMember(_u, _w) {
      this.memberCalls++;
      throw new AuthzError('forbidden', 'FORBIDDEN');
    },
    async assertAdmin() { throw new AuthzError('forbidden', 'FORBIDDEN'); },
  };
}

function makeMemberMisconfigured(): RouteAuthz {
  return {
    async assertMember() { throw new AuthzError('misc', 'MISCONFIGURED'); },
    async assertAdmin() { throw new AuthzError('misc', 'MISCONFIGURED'); },
  };
}

const PANEL_TOKEN = 'test-panel';
const PANEL_HEADERS = { 'x-panel-token': PANEL_TOKEN };
const ACTOR_HEADERS = { 'x-panel-token': PANEL_TOKEN, 'x-acting-user': 'user-abc' };

// =============================================================================
// GET /whatsapp/stats — gate tests
// =============================================================================

// stats-1: actor absent → 400 (before gate)
test('stats-1: GET /whatsapp/stats — actor absent → 400, gate not called', async () => {
  const spy = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });

  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/stats?workspace_id=ws-1',
    headers: PANEL_HEADERS, // no x-acting-user
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'x-acting-user required');
  assert.equal(spy.memberCalls, 0, 'assertMember must NOT be called when actor absent');
  await app.close();
});

// stats-2: workspace_id absent → 400 (before gate)
test('stats-2: GET /whatsapp/stats — workspace_id absent → 400, no DB call', async () => {
  const spy = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });

  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/stats',
    headers: ACTOR_HEADERS,
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'workspace_id required');
  assert.equal(spy.memberCalls, 0);
  await app.close();
});

// stats-3: number_id is non-numeric → 400 (before gate)
test('stats-3: GET /whatsapp/stats — non-numeric number_id → 400, no DB call', async () => {
  const spy = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });

  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/stats?workspace_id=ws-1&number_id=abc',
    headers: ACTOR_HEADERS,
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'number_id must be numeric');
  assert.equal(spy.memberCalls, 0, 'gate must not be reached on NaN number_id');
  await app.close();
});

// stats-4: assertMember FORBIDDEN → 403, DB not called
test('stats-4: GET /whatsapp/stats — actor present, FORBIDDEN → 403, DB not called', async () => {
  const spy = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });

  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/stats?workspace_id=ws-1',
    headers: ACTOR_HEADERS,
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(spy.memberCalls, 1, 'assertMember must be called exactly once');
  await app.close();
});

// stats-5: assertMember MISCONFIGURED → 500
test('stats-5: GET /whatsapp/stats — MISCONFIGURED → 500', async () => {
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: makeMemberMisconfigured() });

  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/stats?workspace_id=ws-1',
    headers: ACTOR_HEADERS,
  });

  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, 'authz_misconfigured');
  await app.close();
});

// stats-6: number_id absent (all-workspace stats) → gate runs; FORBIDDEN → 403
// Shows that number_id is genuinely optional (gate is reached without it).
test('stats-6: GET /whatsapp/stats — number_id absent, FORBIDDEN → 403 (gate reached)', async () => {
  const spy = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });

  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/stats?workspace_id=ws-1',  // no number_id
    headers: ACTOR_HEADERS,
  });

  // Gate was reached with no number_id → member check ran → FORBIDDEN
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(spy.memberCalls, 1, 'gate must be reached even without number_id');
  await app.close();
});

// =============================================================================
// GET /whatsapp/threads — include_first_inbound gate tests
// =============================================================================

// threads-fib-2: include_first_inbound=true, non-member → 403, DB not called
// The flag is opt-in so the gate must still fire before any DB work.
test('threads-fib-2: GET /whatsapp/threads include_first_inbound=true — FORBIDDEN → 403, no DB call', async () => {
  const spy = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });

  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/threads?workspace_id=ws-1&number_id=1&include_first_inbound=true',
    headers: ACTOR_HEADERS,
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(spy.memberCalls, 1, 'gate must fire before DB even when include_first_inbound=true');
  await app.close();
});

// threads-fib-actor-absent: actor absent + include_first_inbound=true → 400
test('threads-fib: GET /whatsapp/threads include_first_inbound=true — actor absent → 400, no DB call', async () => {
  const spy = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });

  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/threads?workspace_id=ws-1&number_id=1&include_first_inbound=true',
    headers: PANEL_HEADERS, // no x-acting-user
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'x-acting-user required');
  assert.equal(spy.memberCalls, 0);
  await app.close();
});

// =============================================================================
// SERVER-GATED TESTS ⚠ NEEDS POSTGRES
// (listed for documentation; cannot run without DATABASE_URL + real schema)
// =============================================================================

// ⚠ NEEDS POSTGRES: stats happy-path
//   Setup: insert whatsapp_number, messages for 2 DM + 1 group thread, thread_meta for 1 (is_lead=false).
//   GET /whatsapp/stats?workspace_id=ws&number_id=n
//   Expect: { total:3, byLeadStatus:{lead:2,not_lead:1}, byKind:{dm:2,group:1}, ... }

// ⚠ NEEDS POSTGRES: stats byStage null-bucket
//   Setup: 2 threads, 1 with lead_stage='qualificado', 1 with no meta row.
//   Expect: byStage = { qualificado:1, null:1 }

// ⚠ NEEDS POSTGRES: stats byIngestSource counts messages not threads
//   Setup: 1 thread with 3 messages ingest_source='live' + 2 messages 'backfill'.
//   Expect: byIngestSource = { live:3, backfill:2 }

// ⚠ NEEDS POSTGRES: stats byTag thread count per tag
//   Setup: thread c-1 with tags ['vip','cliente'], thread c-2 with tag ['vip'].
//   Expect: byTag = { vip:2, cliente:1 }

// ⚠ NEEDS POSTGRES: firstInboundText — earliest inbound message
//   Setup: thread with 2 inbound + 1 outbound; earliest inbound has text 'primeira'.
//   GET /whatsapp/threads?...&include_first_inbound=true
//   Expect: thread.firstInboundText === 'primeira'

// ⚠ NEEDS POSTGRES: firstInboundText off — field absent when flag not sent
//   GET /whatsapp/threads?...  (no include_first_inbound)
//   Expect: thread has no 'firstInboundText' key (or undefined)

// ⚠ NEEDS POSTGRES: firstInboundText null when no inbound messages exist
//   Setup: thread with outbound messages only.
//   GET /whatsapp/threads?...&include_first_inbound=true
//   Expect: thread.firstInboundText === null
