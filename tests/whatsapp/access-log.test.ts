/**
 * tests/whatsapp/access-log.test.ts
 *
 * DB-FREE unit tests for logAccess helper + route wiring (access-log.ts).
 * All tests here MUST pass locally without a real DB.
 *
 * SERVER-GATED tests (real DB) are noted inline but not run here.
 *
 * Coverage:
 *   1. logAccess inserts into whatsapp_access_log with correct SQL and params.
 *   2. logAccess does NOT throw when the pool.query rejects (fire-and-forget safety).
 *   3. Route wiring: logAccess NOT called when 403 (denied path).
 *   4. Route wiring: logAccess NOT called when 400 (actor absent).
 *   5. Meta-log transaction: SELECT old, upsert, INSERT meta_log within BEGIN/COMMIT
 *      (fake client capturing query sequence, no real DB).
 *
 * SERVER-GATED (require DATABASE_URL + real Postgres):
 *   - logAccess success-path actually persists a row (read-routes-search-export.db.test.ts)
 *   - setLeadStatus creates a whatsapp_thread_meta_log row with correct old/new values
 *     (thread-meta.db.test.ts)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { logAccess } from '../../src/whatsapp/access-log.js';
import { registerReadRoutes } from '../../src/whatsapp/read-routes.js';
import { registerWriteRoutes } from '../../src/whatsapp/write-routes.js';
import { AuthzError } from '../../src/whatsapp/authz.js';
import type { RouteAuthz } from '../../src/whatsapp/route-authz.js';
import type { Pool } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────
// Fake pool helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Fake pool that records all query calls. */
function makeCapturingPool() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
    calls,
  };
  return pool;
}

/** Fake pool whose query always rejects. */
function makeRejectingPool(): Pool {
  return {
    query: async () => {
      throw new Error('simulated DB failure');
    },
  } as unknown as Pool;
}

/** Fake pool that resolves a whatsapp_numbers row. */
function makeNumberPool(workspaceId: string) {
  return {
    query: async (sql: string, params: unknown[]) => {
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
      return { rows: [] };
    },
  } as unknown as Pool;
}

const PANEL_TOKEN = 'test-panel';
const PANEL_HEADERS = { 'x-panel-token': PANEL_TOKEN };
const ACTOR_HEADERS = { 'x-panel-token': PANEL_TOKEN, 'x-acting-user': 'user-abc' };

// ─────────────────────────────────────────────────────────────────────────────
// 1. logAccess: inserts into whatsapp_access_log with correct SQL and params
// ─────────────────────────────────────────────────────────────────────────────
test('logAccess: INSERT targets whatsapp_access_log with actor/action/workspace/number/identifier/meta', async () => {
  const pool = makeCapturingPool();

  logAccess(pool as unknown as Pool, {
    actor: 'user-uuid-1',
    action: 'list_threads',
    workspaceId: 'ws-1',
    numberId: 42,
    identifier: 'c-contact@s.whatsapp.net',
    meta: { query: 'test', count: 3 },
  });

  // Fire-and-forget: the INSERT runs async; we wait a tick for it to settle.
  await new Promise(r => setImmediate(r));

  assert.equal(pool.calls.length, 1, 'exactly 1 INSERT must be issued');
  const { sql, params } = pool.calls[0];
  assert.ok(sql.includes('whatsapp_access_log'), 'SQL must target whatsapp_access_log');
  assert.ok(sql.includes('INSERT INTO'), 'SQL must be an INSERT');
  assert.equal(params[0], 'user-uuid-1', 'param $1 = actor');
  assert.equal(params[1], 'list_threads', 'param $2 = action');
  assert.equal(params[2], 'ws-1', 'param $3 = workspace_id');
  assert.equal(params[3], 42, 'param $4 = number_id');
  assert.equal(params[4], 'c-contact@s.whatsapp.net', 'param $5 = identifier');
  assert.ok(params[5] !== null, 'param $6 = meta JSON (not null)');
  const meta = JSON.parse(params[5] as string);
  assert.equal(meta.query, 'test');
  assert.equal(meta.count, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. logAccess: does NOT throw when pool.query rejects (fire-and-forget safety)
// ─────────────────────────────────────────────────────────────────────────────
test('logAccess: routes pool.query rejection to onError exactly once and does not throw', async () => {
  const pool = makeRejectingPool();

  // Inject a spy error handler. This proves the `.catch()` branch actually ran
  // (a vacuous doesNotReject would pass even if the .catch() were removed and the
  // rejection became an unhandledRejection). Injecting also keeps stderr pristine —
  // no real console.error fires.
  let onErrorCalls = 0;
  let lastErr: unknown = undefined;
  const onError = (err: unknown) => { onErrorCalls += 1; lastErr = err; };

  // Must NOT throw synchronously.
  logAccess(pool, {
    actor: 'user-1',
    action: 'export',
    workspaceId: 'ws-1',
    numberId: 1,
  }, onError);

  // Wait a tick so the fire-and-forget settles.
  await new Promise(r => setImmediate(r));

  assert.equal(onErrorCalls, 1, 'onError must be invoked exactly once (proves the .catch() ran)');
  assert.ok(lastErr instanceof Error, 'onError receives the rejection error');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Route wiring: logAccess NOT called when 403 (authz denied)
// ─────────────────────────────────────────────────────────────────────────────
test('GET /whatsapp/threads — logAccess NOT called on 403 (forbidden)', async () => {
  let logCalled = false;
  const fakeLog = (_pool: Pool, _p: unknown) => { logCalled = true; };

  const forbiddenAuthz: RouteAuthz = {
    async assertMember() { throw new AuthzError('forbidden', 'FORBIDDEN'); },
    async assertAdmin() { throw new AuthzError('forbidden', 'FORBIDDEN'); },
  };

  const app = Fastify({ logger: false });
  registerReadRoutes(app, {
    pool: makeNumberPool('ws-1'),
    panelToken: PANEL_TOKEN,
    authz: forbiddenAuthz,
    logAccess: fakeLog,
  });

  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/threads?workspace_id=ws-1&number_id=1',
    headers: ACTOR_HEADERS,
  });

  assert.equal(res.statusCode, 403);
  assert.equal(logCalled, false, 'logAccess must NOT be called when the gate denies');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Route wiring: logAccess NOT called when 400 (actor absent)
// ─────────────────────────────────────────────────────────────────────────────
test('GET /whatsapp/threads — logAccess NOT called on 400 (actor absent)', async () => {
  let logCalled = false;
  const fakeLog = (_pool: Pool, _p: unknown) => { logCalled = true; };

  const passAuthz: RouteAuthz = {
    async assertMember() { /* pass */ },
    async assertAdmin() { /* pass */ },
  };

  const app = Fastify({ logger: false });
  registerReadRoutes(app, {
    pool: makeNumberPool('ws-1'),
    panelToken: PANEL_TOKEN,
    authz: passAuthz,
    logAccess: fakeLog,
  });

  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/threads?workspace_id=ws-1&number_id=1',
    headers: PANEL_HEADERS,  // no x-acting-user
  });

  assert.equal(res.statusCode, 400);
  assert.equal(logCalled, false, 'logAccess must NOT be called when actor is absent');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 4c. Numeric guard: non-numeric number_id → 400 BEFORE any DB hit
//     Number('abc') = NaN is truthy-bypasses the !number_id guard; without the
//     NaN guard it would reach Postgres as a BIGINT param → 500.
// ─────────────────────────────────────────────────────────────────────────────
test('GET /whatsapp/threads — number_id=abc → 400 (numeric guard, no DB hit)', async () => {
  let dbHit = false;
  const trapPool = {
    query: async () => { dbHit = true; return { rows: [] }; },
    connect: async () => { dbHit = true; throw new Error('must not connect'); },
  } as unknown as Pool;

  const passAuthz: RouteAuthz = {
    async assertMember() { /* pass */ },
    async assertAdmin() { /* pass */ },
  };

  const app = Fastify({ logger: false });
  registerReadRoutes(app, {
    pool: trapPool,
    panelToken: PANEL_TOKEN,
    authz: passAuthz,
    logAccess: () => { /* no-op */ },
  });

  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/threads?workspace_id=ws-1&number_id=abc',
    headers: ACTOR_HEADERS,
  });

  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'number_id must be numeric');
  assert.equal(dbHit, false, 'no DB query/connect must happen when number_id is non-numeric');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 4b. Write route wiring: logAccess NOT called on 403
// ─────────────────────────────────────────────────────────────────────────────
test('POST /whatsapp/threads/:id/lead — logAccess NOT called on 403 (admin denied)', async () => {
  let logCalled = false;
  const fakeLog = (_pool: Pool, _p: unknown) => { logCalled = true; };

  const forbiddenAuthz: RouteAuthz = {
    async assertMember() { /* pass (not called on write) */ },
    async assertAdmin() { throw new AuthzError('forbidden', 'FORBIDDEN'); },
  };

  const app = Fastify({ logger: false });
  registerWriteRoutes(app, {
    pool: makeNumberPool('ws-1'),
    panelToken: PANEL_TOKEN,
    authz: forbiddenAuthz,
    logAccess: fakeLog,
  });

  const res = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/c-1/lead',
    headers: ACTOR_HEADERS,
    payload: { number_id: 1, status: 'lead' },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(logCalled, false, 'logAccess must NOT be called when admin gate denies');
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Meta-log transaction: SELECT old, upsert, INSERT meta_log, BEGIN/COMMIT
//    Uses a fake client to capture the query sequence — no real DB required.
// ─────────────────────────────────────────────────────────────────────────────
test('setLeadStatus: issues BEGIN, SELECT, upsert, INSERT meta_log, COMMIT in order', async () => {
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];

  const fakeClient = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql: sql.trim(), params });
      // For the SELECT, return an existing row (is_lead = true) so we can assert old_value.
      // T7 estendeu o SELECT para `SELECT is_lead, lead_stage FROM ...` (captura old stage também).
      if (sql.includes('SELECT is_lead') && sql.includes('FROM whatsapp_thread_meta')) {
        return { rows: [{ is_lead: true }] };
      }
      return { rows: [] };
    },
    release: () => { /* no-op */ },
  };

  const fakePool = {
    connect: async () => fakeClient,
  } as unknown as Pool;

  // Dynamic import to access the function after module is loaded.
  const { setLeadStatus } = await import('../../src/whatsapp/thread-meta.js');

  await setLeadStatus(fakePool, {
    numberId: 7,
    identifier: 'contact@s.whatsapp.net',
    isLead: false,
    updatedBy: 'admin-user',
  });

  // Assert query sequence
  const sqls = queries.map(q => q.sql);
  assert.equal(sqls[0], 'BEGIN', 'first query must be BEGIN');

  const selectIdx = sqls.findIndex(s => s.includes('SELECT is_lead') && s.includes('FROM whatsapp_thread_meta'));
  assert.ok(selectIdx > 0, 'SELECT old value must be issued after BEGIN');

  const upsertIdx = sqls.findIndex(s => s.includes('ON CONFLICT'));
  assert.ok(upsertIdx > selectIdx, 'upsert must come after SELECT');

  const metaLogIdx = sqls.findIndex(s => s.includes('whatsapp_thread_meta_log'));
  assert.ok(metaLogIdx > upsertIdx, 'meta_log INSERT must come after upsert');

  const commitIdx = sqls.findIndex(s => s === 'COMMIT');
  assert.ok(commitIdx > metaLogIdx, 'COMMIT must come after meta_log INSERT');

  // Assert params of the meta_log INSERT
  const metaParams = queries[metaLogIdx].params as unknown[];
  assert.equal(metaParams[0], 7, 'meta_log: number_id');
  assert.equal(metaParams[1], 'contact@s.whatsapp.net', 'meta_log: identifier');
  assert.equal(metaParams[2], 'is_lead', 'meta_log: field');
  assert.equal(metaParams[3], 'true', 'meta_log: old_value (was true)');
  assert.equal(metaParams[4], 'false', 'meta_log: new_value (now false)');
  assert.equal(metaParams[5], 'admin-user', 'meta_log: actor');
});

test('setLeadStatus: old_value is null when no prior row exists', async () => {
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];

  const fakeClient = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql: sql.trim(), params });
      // SELECT returns empty (no prior row).
      return { rows: [] };
    },
    release: () => { /* no-op */ },
  };

  const fakePool = {
    connect: async () => fakeClient,
  } as unknown as Pool;

  const { setLeadStatus } = await import('../../src/whatsapp/thread-meta.js');

  await setLeadStatus(fakePool, {
    numberId: 8,
    identifier: 'new@s.whatsapp.net',
    isLead: true,
    updatedBy: 'admin-2',
  });

  const metaLogQuery = queries.find(q => q.sql.includes('whatsapp_thread_meta_log'));
  assert.ok(metaLogQuery, 'meta_log INSERT must be present');
  const params = metaLogQuery!.params as unknown[];
  assert.equal(params[3], null, 'old_value must be null when there was no prior row');
  assert.equal(params[4], 'true', 'new_value = true');
});

test('setLeadStatus: ROLLBACK is called and error is re-thrown when upsert fails', async () => {
  let rolled = false;
  const fakeClient = {
    query: async (sql: string) => {
      const s = sql.trim();
      if (s === 'BEGIN') return { rows: [] };
      if (s.includes('SELECT is_lead')) return { rows: [] };
      if (s.includes('ON CONFLICT')) throw new Error('simulated upsert failure');
      if (s === 'ROLLBACK') { rolled = true; return { rows: [] }; }
      return { rows: [] };
    },
    release: () => { /* no-op */ },
  };

  const fakePool = {
    connect: async () => fakeClient,
  } as unknown as Pool;

  const { setLeadStatus } = await import('../../src/whatsapp/thread-meta.js');

  await assert.rejects(
    () => setLeadStatus(fakePool, { numberId: 9, identifier: 'x@s.whatsapp.net', isLead: false, updatedBy: 'u' }),
    /simulated upsert failure/,
    'error must be re-thrown after ROLLBACK',
  );
  assert.equal(rolled, true, 'ROLLBACK must be called on failure');
});

test('setLeadStatus: original error propagates even when ROLLBACK itself throws', async () => {
  const fakeClient = {
    query: async (sql: string) => {
      const s = sql.trim();
      if (s === 'BEGIN') return { rows: [] };
      if (s.includes('SELECT is_lead')) return { rows: [] };
      if (s.includes('ON CONFLICT')) throw new Error('original upsert failure');
      if (s === 'ROLLBACK') throw new Error('rollback failure (dead connection)');
      return { rows: [] };
    },
    release: () => { /* no-op */ },
  };

  const fakePool = {
    connect: async () => fakeClient,
  } as unknown as Pool;

  const { setLeadStatus } = await import('../../src/whatsapp/thread-meta.js');

  // The original upsert error must surface — NOT the rollback error.
  await assert.rejects(
    () => setLeadStatus(fakePool, { numberId: 10, identifier: 'y@s.whatsapp.net', isLead: false, updatedBy: 'u' }),
    /original upsert failure/,
    'original error must propagate even when ROLLBACK throws',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SERVER-GATED (documented, not run here):
//
// - "logAccess persists row to whatsapp_access_log with actor/action fields" →
//   needs real DB; add assertions in read-routes-search-export.db.test.ts or
//   a new access-log.db.test.ts.
//
// - "setLeadStatus creates whatsapp_thread_meta_log row with old/new values" →
//   needs real DB; extend thread-meta.db.test.ts.
//
// - "export logAccess records messageCount in meta" →
//   needs real DB + real conversation data.
// ─────────────────────────────────────────────────────────────────────────────
