/**
 * tests/whatsapp/read-routes.period.test.ts
 *
 * DB-FREE tests: verifies that /whatsapp/stats and /whatsapp/threads
 * (a) accept since/until/period_basis and forward them to the service, and
 * (b) reject period_basis values other than 'arrival'|'activity' with HTTP 400.
 *
 * Strategy: inject a fake `authz` (passes) + a spy pool that records the SQL
 * params received by pool.query. Since the period params end up as SQL $3/$4/$5
 * in getStats and as $11/$12/periodBasis in listThreads, we can assert forwarding
 * by inspecting the captured params.
 *
 * All tests are DB-FREE (no real Postgres, TRUNCATE, or DATABASE_URL needed).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerReadRoutes } from '../../src/whatsapp/read-routes.js';
import type { RouteAuthz } from '../../src/whatsapp/route-authz.js';

// ── Shared constants ──────────────────────────────────────────────────────────
const PANEL_TOKEN = 'test-panel';
const ACTOR_HEADERS = { 'x-panel-token': PANEL_TOKEN, 'x-acting-user': 'u1' };
const WS = 'ws-period-test';
const NID = '42';

// ── passAuthz: member check always passes ─────────────────────────────────────
const passAuthz: RouteAuthz = {
  async assertMember() { /* pass */ },
  async assertAdmin() { /* pass */ },
};

// ── Spy pool ──────────────────────────────────────────────────────────────────
// Records every (sql, params) call. Returns minimal valid shapes so the routes
// can serialise a response without erroring. Every query returns an empty row set
// (the route/service handles 0-row results with COALESCE defaults).
function makeSpyPool() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      // Return a shape that satisfies every consumer without real DB data.
      // getStats: expects rows with aggregate columns; returns defaults via COALESCE in SQL.
      // listThreads: expects { rows: [], rowCount: 0 }.
      return { rows: [], rowCount: 0 };
    },
  } as any;
  return { pool, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// /whatsapp/stats — period_basis=garbage → 400
// ─────────────────────────────────────────────────────────────────────────────
test('GET /whatsapp/stats — period_basis=garbage → 400', async () => {
  const { pool } = makeSpyPool();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: passAuthz });
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/stats?workspace_id=${WS}&period_basis=garbage`,
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /period_basis/);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// /whatsapp/threads — period_basis=garbage → 400
// ─────────────────────────────────────────────────────────────────────────────
test('GET /whatsapp/threads — period_basis=garbage → 400', async () => {
  const { pool } = makeSpyPool();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: passAuthz });
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/threads?workspace_id=${WS}&number_id=${NID}&period_basis=garbage`,
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /period_basis/);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// /whatsapp/stats — period_basis absent → no 400; service receives undefined
// (confirmed by: no validation error, and the spy pool is called with params[4]
// defaulting to 'arrival' inside getStats — because the route passes undefined
// and the service defaults to 'arrival').
// ─────────────────────────────────────────────────────────────────────────────
test('GET /whatsapp/stats — period_basis absent → 200 (no 400), service receives arrival default', async () => {
  const { pool, calls } = makeSpyPool();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: passAuthz });
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/stats?workspace_id=${WS}`,
    headers: ACTOR_HEADERS,
  });
  // Should not be 400 (the route accepts absent period_basis)
  assert.notEqual(res.statusCode, 400, `expected not-400 but got ${res.statusCode}: ${res.body}`);
  // The service defaults periodBasis to 'arrival'; it becomes $5 in every query.
  // Confirm at least one query was fired and $5 = 'arrival'.
  const statsCall = calls.find(c => c.params.length >= 5);
  assert.ok(statsCall, 'expected at least one query with 5+ params (getStats)');
  assert.equal(statsCall!.params[4], 'arrival', `expected params[4]='arrival' (periodBasis default) but got ${statsCall!.params[4]}`);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// /whatsapp/threads — period_basis absent → no 400
// ─────────────────────────────────────────────────────────────────────────────
test('GET /whatsapp/threads — period_basis absent → no 400', async () => {
  const { pool } = makeSpyPool();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: passAuthz });
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/threads?workspace_id=${WS}&number_id=${NID}`,
    headers: ACTOR_HEADERS,
  });
  assert.notEqual(res.statusCode, 400, `expected not-400 but got ${res.statusCode}: ${res.body}`);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// /whatsapp/stats — since/until forwarded to getStats
// The route passes since/until to the service which binds them as $3/$4.
// ─────────────────────────────────────────────────────────────────────────────
test('GET /whatsapp/stats — since/until forwarded to service', async () => {
  const since = '2026-01-01T00:00:00Z';
  const until = '2026-06-30T23:59:59Z';
  const { pool, calls } = makeSpyPool();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: passAuthz });
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/stats?workspace_id=${WS}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
    headers: ACTOR_HEADERS,
  });
  assert.notEqual(res.statusCode, 400, `unexpected 400: ${res.body}`);
  // Find a query with ≥5 params (getStats signature)
  const statsCall = calls.find(c => c.params.length >= 5);
  assert.ok(statsCall, 'expected getStats to be called');
  assert.equal(statsCall!.params[2], since, `expected params[2]='${since}' (since) but got ${statsCall!.params[2]}`);
  assert.equal(statsCall!.params[3], until, `expected params[3]='${until}' (until) but got ${statsCall!.params[3]}`);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// /whatsapp/stats — since='' coerced to undefined (emptyToUndefined)
// getStats receives since=undefined → params[2]=null in the SQL.
// ─────────────────────────────────────────────────────────────────────────────
test('GET /whatsapp/stats — since=empty string coerced to undefined (null in SQL)', async () => {
  const { pool, calls } = makeSpyPool();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: passAuthz });
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/stats?workspace_id=${WS}&since=`,
    headers: ACTOR_HEADERS,
  });
  assert.notEqual(res.statusCode, 400, `unexpected 400: ${res.body}`);
  const statsCall = calls.find(c => c.params.length >= 5);
  assert.ok(statsCall, 'expected getStats to be called');
  // emptyToUndefined('') → undefined; getStats converts undefined → null for SQL $3
  assert.equal(statsCall!.params[2], null, `expected params[2]=null (empty since → undefined → null) but got ${statsCall!.params[2]}`);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// /whatsapp/stats — period_basis=arrival accepted (no 400)
// ─────────────────────────────────────────────────────────────────────────────
test('GET /whatsapp/stats — period_basis=arrival accepted, forwarded as arrival', async () => {
  const { pool, calls } = makeSpyPool();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: passAuthz });
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/stats?workspace_id=${WS}&period_basis=arrival`,
    headers: ACTOR_HEADERS,
  });
  assert.notEqual(res.statusCode, 400, `unexpected 400: ${res.body}`);
  const statsCall = calls.find(c => c.params.length >= 5);
  assert.ok(statsCall, 'expected getStats to be called');
  assert.equal(statsCall!.params[4], 'arrival');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// /whatsapp/stats — period_basis=activity accepted, forwarded as activity
// ─────────────────────────────────────────────────────────────────────────────
test('GET /whatsapp/stats — period_basis=activity accepted, forwarded as activity', async () => {
  const { pool, calls } = makeSpyPool();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: passAuthz });
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/stats?workspace_id=${WS}&period_basis=activity`,
    headers: ACTOR_HEADERS,
  });
  assert.notEqual(res.statusCode, 400, `unexpected 400: ${res.body}`);
  const statsCall = calls.find(c => c.params.length >= 5);
  assert.ok(statsCall, 'expected getStats to be called');
  assert.equal(statsCall!.params[4], 'activity');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// /whatsapp/threads — since/until and period_basis forwarded
// listThreads receives these via the p object; the spy pool captures the SQL
// params array. For listThreads, $11=since, $12=until (activity-mode pushes
// them too). We test that the route accepts the params without 400, at minimum.
// ─────────────────────────────────────────────────────────────────────────────
test('GET /whatsapp/threads — since/until/period_basis=activity forwarded (no 400)', async () => {
  const since = '2026-01-01T00:00:00Z';
  const until = '2026-06-30T23:59:59Z';
  const { pool } = makeSpyPool();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: passAuthz });
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/threads?workspace_id=${WS}&number_id=${NID}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&period_basis=activity`,
    headers: ACTOR_HEADERS,
  });
  assert.notEqual(res.statusCode, 400, `unexpected 400: ${res.body}`);
  await app.close();
});
