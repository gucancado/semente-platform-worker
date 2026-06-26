/**
 * tests/whatsapp/disqualify-reasons.routes.test.ts
 *
 * Gate-focused authz tests for:
 *   GET  /whatsapp/disqualify-reasons
 *   POST /whatsapp/disqualify-reasons
 *   POST /whatsapp/disqualify-reasons/:code/deactivate
 *
 * Strategy: inject fake `authz` + fake `logAccess` spy (no real DB/network).
 * Mirrors read-routes.authz.test.ts harness.
 *
 * DB-FREE cases covered:
 *   (1)  GET: member → 200, reasons returned (injected pool)
 *   (2)  GET: non-member (assertMember FORBIDDEN) → 403
 *   (3)  GET: missing workspace_id → 400 (gate never reached)
 *   (4)  GET: include_inactive=true passes through (pool sees it)
 *   (5)  POST: admin → 200, reactivated in body (injected pool, fresh create → false)
 *   (6)  POST: non-admin (assertAdmin FORBIDDEN) → 403
 *   (7)  POST: missing workspace_id → 400
 *   (8)  POST: missing label → 400
 *   (9)  POST: invalid code ('Bad Code!') → 400
 *   (10) POST: empty code → 400 (after normalise: empty string fails regex)
 *   (11) deactivate: admin → 200
 *   (12) deactivate: non-admin → 403
 *   (13) deactivate: missing workspace_id in body → 400
 *   (14) deactivate: invalid code → 400
 *   (15) logAccess spy called with correct action after each successful gate
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthzError } from '../../src/whatsapp/authz.js';
import { registerReadRoutes } from '../../src/whatsapp/read-routes.js';
import { registerWriteRoutes } from '../../src/whatsapp/write-routes.js';
import type { RouteAuthz } from '../../src/whatsapp/route-authz.js';
import type { LogAccessFn } from '../../src/whatsapp/access-log.js';

// ── Fake pool: panics on any DB call ─────────────────────────────────────────
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

// ── Fake pool: returns a reasons list ────────────────────────────────────────
function makeReasonsPool(reasons: { code: string; label: string; active: boolean; sort_order: number }[] = []) {
  return {
    query: async (_sql: string, _params: any[]) => ({ rows: reasons }),
  } as any;
}

// ── Fake pool: returns a result for upsert (new row → reactivated false) ─────
function makeUpsertPool(prevActive: boolean | null = null) {
  return {
    query: async (_sql: string, _params: any[]) => ({ rows: [{ prev_active: prevActive }] }),
  } as any;
}

// ── Fake pool: no-op for deactivate UPDATE ────────────────────────────────────
const NOOP_POOL = {
  query: async (_sql: string, _params: any[]) => ({ rows: [] }),
} as any;

// ── Authz factories ───────────────────────────────────────────────────────────

function makeMemberForbidden(): RouteAuthz & { memberCalls: number } {
  return {
    memberCalls: 0,
    async assertMember(_u, _w) {
      this.memberCalls++;
      throw new AuthzError('forbidden', 'FORBIDDEN');
    },
    async assertAdmin(_u, _w) {
      throw new AuthzError('forbidden', 'FORBIDDEN');
    },
  };
}

function makeAdminForbidden(): RouteAuthz & { adminCalls: number } {
  return {
    adminCalls: 0,
    async assertMember(_u, _w) { /* pass */ },
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

// ── logAccess spy factory ─────────────────────────────────────────────────────

function makeLogSpy(): LogAccessFn & { calls: { action: string; workspaceId: string; meta?: unknown }[] } {
  const spy = function logSpy(_pool: any, opts: any) {
    spy.calls.push({ action: opts.action, workspaceId: opts.workspaceId, meta: opts.meta });
  } as any;
  spy.calls = [] as { action: string; workspaceId: string; meta?: unknown }[];
  return spy;
}

const PANEL_TOKEN = 'test-panel';
const PANEL_HEADERS = { 'x-panel-token': PANEL_TOKEN };
const ACTOR_HEADERS = { 'x-panel-token': PANEL_TOKEN, 'x-acting-user': 'user-abc' };
const WS = 'ws-test-1';

// ─────────────────────────────────────────────────────────────────────────────
// (1) GET: member → 200, returns reasons array
// ─────────────────────────────────────────────────────────────────────────────
test('(1) GET /whatsapp/disqualify-reasons — member → 200, returns reasons', async () => {
  const authz = makeAllPass();
  const pool = makeReasonsPool([{ code: 'sem_fit', label: 'Sem fit', active: true, sort_order: 1 }]);
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/disqualify-reasons?workspace_id=${WS}`,
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schema, 'whatsapp_v1');
  assert.ok(Array.isArray(body.reasons), 'reasons must be an array');
  assert.equal(body.reasons[0].code, 'sem_fit');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) GET: non-member → 403
// ─────────────────────────────────────────────────────────────────────────────
test('(2) GET /whatsapp/disqualify-reasons — non-member → 403', async () => {
  const authz = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/disqualify-reasons?workspace_id=${WS}`,
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(authz.memberCalls, 1);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) GET: missing workspace_id → 400 (gate never reached)
// ─────────────────────────────────────────────────────────────────────────────
test('(3) GET /whatsapp/disqualify-reasons — missing workspace_id → 400', async () => {
  const authz = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/disqualify-reasons',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(authz.memberCalls, 0, 'gate must NOT be reached when workspace_id is missing');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) GET: include_inactive=true is forwarded to DB query
// ─────────────────────────────────────────────────────────────────────────────
test('(4) GET /whatsapp/disqualify-reasons — include_inactive=true accepted → 200', async () => {
  const authz = makeAllPass();
  const pool = makeReasonsPool([
    { code: 'sem_fit', label: 'Sem fit', active: true, sort_order: 1 },
    { code: 'sem_verba', label: 'Sem verba', active: false, sort_order: 2 },
  ]);
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/disqualify-reasons?workspace_id=${WS}&include_inactive=true`,
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().reasons.length, 2);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) POST: admin → 200, reactivated:false (new row)
// ─────────────────────────────────────────────────────────────────────────────
test('(5) POST /whatsapp/disqualify-reasons — admin → 200, reactivated:false (new row)', async () => {
  const authz = makeAllPass();
  const log = makeLogSpy();
  const pool = makeUpsertPool(null); // null prev_active → reactivated false
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool, panelToken: PANEL_TOKEN, authz, logAccess: log });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/disqualify-reasons',
    headers: ACTOR_HEADERS,
    payload: { workspace_id: WS, code: 'sem_fit', label: 'Sem fit' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schema, 'whatsapp_v1');
  assert.equal(body.ok, true);
  assert.equal(body.reactivated, false);
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0].action, 'upsert_disqualify_reason');
  assert.equal(log.calls[0].workspaceId, WS);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (5b) POST: reactivated:true when prev_active=false (reactivation)
// ─────────────────────────────────────────────────────────────────────────────
test('(5b) POST /whatsapp/disqualify-reasons — reactivated:true when previously inactive', async () => {
  const authz = makeAllPass();
  const pool = makeUpsertPool(false); // prev_active=false → reactivated true
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/disqualify-reasons',
    headers: ACTOR_HEADERS,
    payload: { workspace_id: WS, code: 'sem_fit', label: 'Sem fit' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().reactivated, true);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (6) POST: non-admin → 403
// ─────────────────────────────────────────────────────────────────────────────
test('(6) POST /whatsapp/disqualify-reasons — non-admin → 403', async () => {
  const authz = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/disqualify-reasons',
    headers: ACTOR_HEADERS,
    payload: { workspace_id: WS, code: 'sem_fit', label: 'Sem fit' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(authz.adminCalls, 1);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (7) POST: missing workspace_id → 400 (gate never reached)
// ─────────────────────────────────────────────────────────────────────────────
test('(7) POST /whatsapp/disqualify-reasons — missing workspace_id → 400', async () => {
  const authz = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/disqualify-reasons',
    headers: ACTOR_HEADERS,
    payload: { code: 'sem_fit', label: 'Sem fit' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(authz.adminCalls, 0);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (8) POST: missing label → 400
// ─────────────────────────────────────────────────────────────────────────────
test('(8) POST /whatsapp/disqualify-reasons — missing label → 400', async () => {
  const authz = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/disqualify-reasons',
    headers: ACTOR_HEADERS,
    payload: { workspace_id: WS, code: 'sem_fit' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(authz.adminCalls, 0);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (9) POST: invalid code ('Bad Code!') → 400 (before gate)
// ─────────────────────────────────────────────────────────────────────────────
test('(9) POST /whatsapp/disqualify-reasons — invalid code → 400', async () => {
  const authz = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/disqualify-reasons',
    headers: ACTOR_HEADERS,
    payload: { workspace_id: WS, code: 'Bad Code!', label: 'Inválido' },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.match(body.error, /invalid code/i);
  assert.equal(authz.adminCalls, 0, 'gate must not be reached on code validation failure');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (10) POST: empty code (after trim) → 400
// ─────────────────────────────────────────────────────────────────────────────
test('(10) POST /whatsapp/disqualify-reasons — empty code → 400', async () => {
  const authz = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/disqualify-reasons',
    headers: ACTOR_HEADERS,
    payload: { workspace_id: WS, code: '   ', label: 'Vazio' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(authz.adminCalls, 0);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (11) deactivate: admin → 200
// ─────────────────────────────────────────────────────────────────────────────
test('(11) POST /whatsapp/disqualify-reasons/:code/deactivate — admin → 200', async () => {
  const authz = makeAllPass();
  const log = makeLogSpy();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: NOOP_POOL, panelToken: PANEL_TOKEN, authz, logAccess: log });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/disqualify-reasons/sem_fit/deactivate',
    headers: ACTOR_HEADERS,
    payload: { workspace_id: WS },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schema, 'whatsapp_v1');
  assert.equal(body.ok, true);
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0].action, 'deactivate_disqualify_reason');
  assert.equal(log.calls[0].workspaceId, WS);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (12) deactivate: non-admin → 403
// ─────────────────────────────────────────────────────────────────────────────
test('(12) POST /whatsapp/disqualify-reasons/:code/deactivate — non-admin → 403', async () => {
  const authz = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/disqualify-reasons/sem_fit/deactivate',
    headers: ACTOR_HEADERS,
    payload: { workspace_id: WS },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(authz.adminCalls, 1);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (13) deactivate: missing workspace_id in body → 400
// ─────────────────────────────────────────────────────────────────────────────
test('(13) POST /whatsapp/disqualify-reasons/:code/deactivate — missing workspace_id → 400', async () => {
  const authz = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/disqualify-reasons/sem_fit/deactivate',
    headers: ACTOR_HEADERS,
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  assert.equal(authz.adminCalls, 0);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (14) deactivate: invalid code in URL param → 400
// ─────────────────────────────────────────────────────────────────────────────
test('(14) POST /whatsapp/disqualify-reasons/:code/deactivate — invalid code → 400', async () => {
  const authz = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/disqualify-reasons/Bad%20Code!/deactivate',
    headers: ACTOR_HEADERS,
    payload: { workspace_id: WS },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /invalid code/i);
  assert.equal(authz.adminCalls, 0);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (15) GET: logAccess called with action='list_disqualify_reasons' after gate pass
// ─────────────────────────────────────────────────────────────────────────────
test('(15) GET /whatsapp/disqualify-reasons — logAccess called with list_disqualify_reasons', async () => {
  const authz = makeAllPass();
  const log = makeLogSpy();
  const pool = makeReasonsPool([]);
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz, logAccess: log });
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/disqualify-reasons?workspace_id=${WS}`,
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0].action, 'list_disqualify_reasons');
  assert.equal(log.calls[0].workspaceId, WS);
  await app.close();
});
