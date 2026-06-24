/**
 * tests/whatsapp/read-routes.authz.test.ts
 *
 * Exercises the authz GATE on /whatsapp/* routes WITHOUT a real DB or network.
 * Strategy: inject a fake `authz` dep into registerReadRoutes / registerWriteRoutes;
 * inject a fake `pool` that never hits postgres; verify HTTP status codes.
 *
 * SERVER-GATED cases (marked below) need a real DB + real Bloquim endpoint and
 * are excluded from local runs — they live in read-routes.test.ts /
 * write-routes.db.test.ts (which TRUNCATE and require DATABASE_URL).
 *
 * DB-FREE gate cases covered here:
 *   (a) threads: actor present, assertMember throws FORBIDDEN → 403
 *   (b) threads: actor absent → 400, assertMember NOT called
 *   (c) threads: assertMember throws MISCONFIGURED → 500
 *   (d) lead POST: actor present, assertAdmin throws FORBIDDEN → 403
 *   (e) lead POST: actor absent → 400
 *   (f) lead POST: write route uses assertAdmin (not assertMember):
 *         fake whose assertMember passes but assertAdmin throws → still 403
 *   (g) numbers: actor absent → 400
 *   (h) numbers: assertMember FORBIDDEN → 403
 *   (i) search: actor absent → 400
 *   (j) export: actor absent → 400
 *   (k) export: authz derives workspace from number_id (NOT caller workspace_id),
 *         assertMember FORBIDDEN → 403 (regression guard for cross-workspace leak)
 *
 * Notes:
 *   - messages route (actor-absent DB-free): the actor check runs BEFORE getNumber,
 *     so it is 400 without any DB call → confirmed DB-free.
 *   - lead route (actor-absent DB-free): same pattern — actor check before getNumber.
 *   - export route (actor-absent DB-free): same pattern — actor check before getNumber.
 *   - export route (k): DB-free via makeNumberPool (resolves the number row) + injected
 *     authz, so no real DB/Bloquim is hit; the gate is reached and denied.
 *   - Happy-path (200) cases for messages/lead/export require a real number row →
 *     SERVER-GATED. Export number-not-found→404 is reachable DB-free in principle but
 *     left to the server-gated suite alongside the 200 happy path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthzError } from '../../src/whatsapp/authz.js';
import { registerReadRoutes } from '../../src/whatsapp/read-routes.js';
import { registerWriteRoutes } from '../../src/whatsapp/write-routes.js';
import type { RouteAuthz } from '../../src/whatsapp/route-authz.js';

// ── Fake pool: panics if any query is actually executed ──────────────────────
// The gate cases must NEVER reach the DB; if they do, the test should fail clearly.
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

// ── Fake pool that resolves a number row (for derive-workspace tests) ─────────
// Only used in cases where actor IS present and we need the number row to exist.
function makeNumberPool(workspaceId: string) {
  return {
    query: async (sql: string, params: any[]) => {
      // Respond to getNumber (SELECT ... WHERE id = $1)
      if (sql.includes('WHERE id =')) {
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
      throw new Error(`Unexpected DB call: ${sql}`);
    },
  } as any;
}

const PANEL_TOKEN = 'test-panel';
const PANEL_HEADERS = { 'x-panel-token': PANEL_TOKEN };
const ACTOR_HEADERS = { 'x-panel-token': PANEL_TOKEN, 'x-acting-user': 'user-abc' };

// ── Authz factories ───────────────────────────────────────────────────────────

function makeMemberForbidden(): RouteAuthz & { memberCalls: number; adminCalls: number } {
  return {
    memberCalls: 0,
    adminCalls: 0,
    async assertMember(_u, _w) {
      this.memberCalls++;
      throw new AuthzError('forbidden', 'FORBIDDEN');
    },
    async assertAdmin(_u, _w) {
      this.adminCalls++;
      throw new AuthzError('forbidden', 'FORBIDDEN');
    },
  };
}

function makeMemberMisconfigured(): RouteAuthz {
  return {
    async assertMember() { throw new AuthzError('misc', 'MISCONFIGURED'); },
    async assertAdmin() { throw new AuthzError('misc', 'MISCONFIGURED'); },
  };
}

function makeAdminForbidden(): RouteAuthz & { memberCalls: number; adminCalls: number } {
  return {
    memberCalls: 0,
    adminCalls: 0,
    async assertMember(_u, _w) {
      this.memberCalls++;
      // passes (member check succeeds)
    },
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

// ─────────────────────────────────────────────────────────────────────────────
// (b) threads: actor absent → 400, assertMember NOT called
// ─────────────────────────────────────────────────────────────────────────────
test('(b) GET /whatsapp/threads — actor absent → 400, assertMember not called', async () => {
  const spy = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/threads?workspace_id=ws-1&number_id=1',
    headers: PANEL_HEADERS,  // no x-acting-user
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'x-acting-user required');
  assert.equal(spy.memberCalls, 0, 'assertMember must NOT be called when actor is absent');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) threads: actor present, assertMember throws FORBIDDEN → 403
// ─────────────────────────────────────────────────────────────────────────────
test('(a) GET /whatsapp/threads — actor present, FORBIDDEN → 403', async () => {
  const spy = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/threads?workspace_id=ws-1&number_id=1',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(spy.memberCalls, 1);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) threads: assertMember throws MISCONFIGURED → 500
// ─────────────────────────────────────────────────────────────────────────────
test('(c) GET /whatsapp/threads — MISCONFIGURED → 500', async () => {
  const authz = makeMemberMisconfigured();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/threads?workspace_id=ws-1&number_id=1',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, 'authz_misconfigured');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (g) numbers: actor absent → 400
// ─────────────────────────────────────────────────────────────────────────────
test('(g) GET /whatsapp/numbers — actor absent → 400', async () => {
  const spy = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/numbers?workspace_id=ws-1',
    headers: PANEL_HEADERS,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'x-acting-user required');
  assert.equal(spy.memberCalls, 0);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (h) numbers: assertMember FORBIDDEN → 403
// ─────────────────────────────────────────────────────────────────────────────
test('(h) GET /whatsapp/numbers — FORBIDDEN → 403', async () => {
  const spy = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/numbers?workspace_id=ws-1',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (i) search: actor absent → 400
// ─────────────────────────────────────────────────────────────────────────────
test('(i) GET /whatsapp/search — actor absent → 400', async () => {
  const spy = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/search?workspace_id=ws-1&number_id=1&query=test',
    headers: PANEL_HEADERS,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'x-acting-user required');
  assert.equal(spy.memberCalls, 0);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (j) export: actor absent → 400 (DB-free: actor check runs BEFORE getNumber)
// ─────────────────────────────────────────────────────────────────────────────
test('(j) GET /whatsapp/threads/:id/export — actor absent → 400 (no DB call)', async () => {
  const spy = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/threads/c-1/export?workspace_id=ws-1&number_id=1',
    headers: PANEL_HEADERS,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'x-acting-user required');
  assert.equal(spy.memberCalls, 0);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (k) export: derives workspace from number_id (NOT caller's workspace_id).
// Actor present, number exists (resolves to ws-real), assertMember FORBIDDEN → 403.
// The fake authz records the workspaceId it was asked to gate; we assert it is the
// number's REAL workspace (ws-real), NOT the caller-supplied workspace_id (ws-attacker).
// This is the regression guard for the cross-workspace export leak.
// ─────────────────────────────────────────────────────────────────────────────
test('(k) GET /whatsapp/threads/:id/export — authz uses workspace derived from number_id, not caller workspace_id → 403', async () => {
  let gatedWorkspace: string | null = null;
  const spy: RouteAuthz & { memberCalls: number } = {
    memberCalls: 0,
    async assertMember(_u, w) {
      this.memberCalls++;
      gatedWorkspace = w;
      throw new AuthzError('forbidden', 'FORBIDDEN');
    },
    async assertAdmin() { /* unused */ },
  };
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: makeNumberPool('ws-real'), panelToken: PANEL_TOKEN, authz: spy });
  const res = await app.inject({
    method: 'GET',
    // Caller LIES about the workspace: passes ws-attacker, but number_id=1 belongs to ws-real.
    url: '/whatsapp/threads/c-1/export?workspace_id=ws-attacker&number_id=1',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(spy.memberCalls, 1);
  assert.equal(gatedWorkspace, 'ws-real', 'export must authorize against the number\'s real workspace, NOT the caller-supplied workspace_id');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// messages: actor absent → 400 (DB-free: actor check runs BEFORE getNumber)
// ─────────────────────────────────────────────────────────────────────────────
test('GET /whatsapp/threads/:id/messages — actor absent → 400 (no DB call)', async () => {
  const spy = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/threads/c-1/messages?number_id=1',
    headers: PANEL_HEADERS,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'x-acting-user required');
  assert.equal(spy.memberCalls, 0);
  await app.close();
});

// messages: actor present, number exists, assertMember FORBIDDEN → 403
// (uses makeNumberPool — no real DB; no Bloquim call since authz is injected)
test('GET /whatsapp/threads/:id/messages — actor present, FORBIDDEN → 403', async () => {
  const spy = makeMemberForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: makeNumberPool('ws-1'), panelToken: PANEL_TOKEN, authz: spy });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/threads/c-1/messages?number_id=1',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(spy.memberCalls, 1);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) lead POST: actor absent → 400
// ─────────────────────────────────────────────────────────────────────────────
test('(e) POST /whatsapp/threads/:id/lead — actor absent → 400 (no DB call)', async () => {
  const spy = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/c-1/lead',
    headers: PANEL_HEADERS,
    payload: { number_id: 1, status: 'lead' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'x-acting-user required');
  assert.equal(spy.adminCalls, 0);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) lead POST: actor present, assertAdmin throws FORBIDDEN → 403
// (f) write route uses assertAdmin (not assertMember): assertMember passes, assertAdmin throws → still 403
// ─────────────────────────────────────────────────────────────────────────────
test('(d)+(f) POST /whatsapp/threads/:id/lead — actor present, assertAdmin FORBIDDEN → 403 (assertMember not called)', async () => {
  const spy = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: makeNumberPool('ws-1'), panelToken: PANEL_TOKEN, authz: spy });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/c-1/lead',
    headers: ACTOR_HEADERS,
    payload: { number_id: 1, status: 'lead' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(spy.adminCalls, 1, 'assertAdmin must be called exactly once');
  assert.equal(spy.memberCalls, 0, 'assertMember must NOT be called on write route');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// lead POST: number not found → 404
// ─────────────────────────────────────────────────────────────────────────────
test('POST /whatsapp/threads/:id/lead — number not found → 404', async () => {
  const authz = makeAllPass();
  const emptyPool = {
    query: async (_sql: string, _params: any[]) => ({ rows: [] }),
  } as any;
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: emptyPool, panelToken: PANEL_TOKEN, authz });
  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/c-1/lead',
    headers: ACTOR_HEADERS,
    payload: { number_id: 999, status: 'lead' },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'number not found');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// SERVER-GATED (happy paths — require real DB + real Bloquim):
//   - GET /whatsapp/numbers with valid member → 200 (numbers array)
//   - GET /whatsapp/threads with valid member → 200
//   - GET /whatsapp/threads/:id/messages with valid member → 200
//   - GET /whatsapp/search with valid member → 200
//   - GET /whatsapp/threads/:id/export with valid member → 200
//   - POST /whatsapp/threads/:id/lead with valid admin → 200
// These are covered by read-routes.test.ts, read-routes-search-export.db.test.ts,
// and write-routes.db.test.ts (all need DATABASE_URL + TRUNCATE).
// ─────────────────────────────────────────────────────────────────────────────
