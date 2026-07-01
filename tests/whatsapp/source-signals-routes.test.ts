/**
 * tests/whatsapp/source-signals-routes.test.ts
 *
 * Gate-focused authz tests for:
 *   GET  /whatsapp/source-signals
 *   POST /whatsapp/source-signals
 *   POST /whatsapp/source-signals/:pattern/deactivate
 *
 * Strategy: inject fake `authz` + fake `logAccess` spy (no real DB/network).
 * Mirrors disqualify-reasons.routes.test.ts harness.
 *
 * DB-FREE cases covered:
 *   (1)  GET: missing workspace_id → 400 (gate never reached)
 *   (2)  GET: member → 200, signals returned (injected pool)
 *   (3)  GET: non-member (assertMember FORBIDDEN) → 403
 *   (4)  POST: admin → 200, logAccess called with upsert_source_signal
 *   (5)  POST: non-admin (assertAdmin FORBIDDEN) → 403
 *   (6)  POST: missing workspace_id → 400
 *   (7)  POST: missing pattern → 400
 *   (8)  POST: missing source → 400
 *   (9)  deactivate: admin → 200, logAccess called with deactivate_source_signal
 *   (10) deactivate: non-admin → 403
 *   (11) deactivate: missing workspace_id → 400
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

// ── Fake pool: returns a signals list ────────────────────────────────────────
function makeSignalsPool(signals: { pattern: string; source: string; active: boolean; sort_order: number }[] = []) {
  return {
    query: async (_sql: string, _params: any[]) => ({ rows: signals }),
  } as any;
}

// ── Fake pool: no-op for upsert/deactivate ────────────────────────────────────
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
const ACTOR_HEADERS = { 'x-panel-token': PANEL_TOKEN, 'x-acting-user': 'user-abc' };
const WS = 'ws-test-1';

// ─────────────────────────────────────────────────────────────────────────────
// (1) GET: missing workspace_id → 400 (gate never reached)
// ─────────────────────────────────────────────────────────────────────────────
test('(1) GET /whatsapp/source-signals — missing workspace_id → 400', async () => {
  const authz = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/source-signals',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(authz.memberCalls, 0, 'gate must NOT be reached when workspace_id is missing');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) GET: member → 200, returns signals array
// ─────────────────────────────────────────────────────────────────────────────
test('(2) GET /whatsapp/source-signals — member → 200, returns signals', async () => {
  const authz = makeAllPass();
  const pool = makeSignalsPool([{ pattern: 'vim pela feira', source: 'organico', active: true, sort_order: 10 }]);
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/source-signals?workspace_id=${WS}`,
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schema, 'whatsapp_v1');
  assert.ok(Array.isArray(body.signals), 'signals must be an array');
  assert.equal(body.signals[0].pattern, 'vim pela feira');
  assert.equal(body.signals[0].source, 'organico');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) GET: non-member (assertMember FORBIDDEN) → 403
// ─────────────────────────────────────────────────────────────────────────────
test('(3) GET /whatsapp/source-signals — non-member → 403', async () => {
  const authz = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/source-signals?workspace_id=${WS}`,
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(authz.memberCalls, 1);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) POST: admin → 200, logAccess called with upsert_source_signal
// ─────────────────────────────────────────────────────────────────────────────
test('(4) POST /whatsapp/source-signals — admin → 200, logAccess upsert_source_signal', async () => {
  const authz = makeAllPass();
  const log = makeLogSpy();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: NOOP_POOL, panelToken: PANEL_TOKEN, authz, logAccess: log });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/source-signals',
    headers: ACTOR_HEADERS,
    payload: { workspace_id: WS, pattern: 'Vim pela feira X', source: 'organico' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schema, 'whatsapp_v1');
  assert.equal(body.ok, true);
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0].action, 'upsert_source_signal');
  assert.equal(log.calls[0].workspaceId, WS);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) POST: non-admin → 403
// ─────────────────────────────────────────────────────────────────────────────
test('(5) POST /whatsapp/source-signals — non-admin → 403', async () => {
  const authz = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/source-signals',
    headers: ACTOR_HEADERS,
    payload: { workspace_id: WS, pattern: 'Vim pela feira', source: 'organico' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(authz.adminCalls, 1);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (6) POST: missing workspace_id → 400 (gate never reached)
// ─────────────────────────────────────────────────────────────────────────────
test('(6) POST /whatsapp/source-signals — missing workspace_id → 400', async () => {
  const authz = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/source-signals',
    headers: ACTOR_HEADERS,
    payload: { pattern: 'Vim pela feira', source: 'organico' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(authz.adminCalls, 0);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (7) POST: missing pattern → 400 (gate never reached)
// ─────────────────────────────────────────────────────────────────────────────
test('(7) POST /whatsapp/source-signals — missing pattern → 400', async () => {
  const authz = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/source-signals',
    headers: ACTOR_HEADERS,
    payload: { workspace_id: WS, source: 'organico' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /pattern/i);
  assert.equal(authz.adminCalls, 0);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (8) POST: missing source → 400 (gate never reached)
// ─────────────────────────────────────────────────────────────────────────────
test('(8) POST /whatsapp/source-signals — missing source → 400', async () => {
  const authz = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/source-signals',
    headers: ACTOR_HEADERS,
    payload: { workspace_id: WS, pattern: 'Vim pela feira' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /source/i);
  assert.equal(authz.adminCalls, 0);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (9) deactivate: admin → 200, logAccess called with deactivate_source_signal
// ─────────────────────────────────────────────────────────────────────────────
test('(9) POST /whatsapp/source-signals/:pattern/deactivate — admin → 200', async () => {
  const authz = makeAllPass();
  const log = makeLogSpy();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: NOOP_POOL, panelToken: PANEL_TOKEN, authz, logAccess: log });
  const res = await app.inject({
    method: 'POST',
    url: `/whatsapp/source-signals/${encodeURIComponent('vim pela feira')}/deactivate`,
    headers: ACTOR_HEADERS,
    payload: { workspace_id: WS },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schema, 'whatsapp_v1');
  assert.equal(body.ok, true);
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0].action, 'deactivate_source_signal');
  assert.equal(log.calls[0].workspaceId, WS);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (10) deactivate: non-admin → 403
// ─────────────────────────────────────────────────────────────────────────────
test('(10) POST /whatsapp/source-signals/:pattern/deactivate — non-admin → 403', async () => {
  const authz = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: `/whatsapp/source-signals/${encodeURIComponent('vim pela feira')}/deactivate`,
    headers: ACTOR_HEADERS,
    payload: { workspace_id: WS },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(authz.adminCalls, 1);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (11) deactivate: missing workspace_id in body → 400
// ─────────────────────────────────────────────────────────────────────────────
test('(11) POST /whatsapp/source-signals/:pattern/deactivate — missing workspace_id → 400', async () => {
  const authz = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: `/whatsapp/source-signals/${encodeURIComponent('vim pela feira')}/deactivate`,
    headers: ACTOR_HEADERS,
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  assert.equal(authz.adminCalls, 0);
  await app.close();
});
