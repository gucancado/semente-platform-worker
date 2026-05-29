import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_OAUTH_CLIENT_ID = 'fake-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'fake-client-secret';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3001/cb';
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.from('a'.repeat(32)).toString('base64');
process.env.GOOGLE_OAUTH_STATE_SECRET = 'state-secret-at-least-40-chars-long-aaaa';

const { cleanupExpiredHolds } = await import('../../../src/goals/scheduling/holds-cleanup.js');

type Row = { id: number; project_id: number; google_event_id: string; person_email: string };

function makeDeps(rows: Row[], deleteFail?: 'all' | number[]) {
  const queries: { sql: string; args?: unknown[] }[] = [];
  return {
    queries,
    deps: {
      query: (async (sql: string, args?: unknown[]) => {
        queries.push({ sql, args });
        if (sql.includes('SELECT')) return { rows };
        return { rowCount: 1 };
      }) as unknown as typeof import('../../../src/db.js').pool.query,
      getConnectionByProjectId: async (project_id: number) => ({
        id: 1, project_id, google_email: 'agent@x.com',
        refresh_token_encrypted: Buffer.from('x'), scopes: [],
        connected_at: new Date(), last_refresh_at: null, last_error: null,
      } as Parameters<typeof import('../../../src/integrations/google/client-factory.js').ensureFreshAccessToken>[0]),
      deleteEvent: async (_conn: unknown, _calId: string, eventId: string) => {
        if (deleteFail === 'all') throw new Error('always fail');
        if (Array.isArray(deleteFail)) {
          const idx = parseInt(eventId.replace('evt-', ''), 10);
          if (deleteFail.includes(idx)) throw new Error(`fail ${eventId}`);
        }
      },
    },
  };
}

test('cleanup: deleta rows expirados', async () => {
  const { deps, queries } = makeDeps([
    { id: 10, project_id: 1, google_event_id: 'evt-1', person_email: 'rod@x.com' },
    { id: 11, project_id: 1, google_event_id: 'evt-2', person_email: 'rod@x.com' },
  ]);
  const result = await cleanupExpiredHolds(undefined, deps);
  assert.equal(result.checked, 2);
  assert.equal(result.deleted, 2);
  assert.equal(result.google_errors, 0);
  const deletes = queries.filter((q) => q.sql.includes('DELETE'));
  assert.equal(deletes.length, 2);
});

test('cleanup: rows vazios → noop', async () => {
  const { deps } = makeDeps([]);
  const result = await cleanupExpiredHolds(undefined, deps);
  assert.deepEqual(result, { checked: 0, deleted: 0, google_errors: 0 });
});

test('cleanup: deleteEvent erro é swallowed; row do DB ainda é deletada', async () => {
  const { deps } = makeDeps([
    { id: 1, project_id: 1, google_event_id: 'evt-1', person_email: 'rod@x.com' },
  ], 'all');
  const result = await cleanupExpiredHolds(undefined, deps);
  assert.equal(result.deleted, 1);
  assert.equal(result.google_errors, 1);
});

test('cleanup: alguns deletes Google falham, outros sucedem', async () => {
  const { deps } = makeDeps([
    { id: 1, project_id: 1, google_event_id: 'evt-1', person_email: 'rod@x.com' },
    { id: 2, project_id: 1, google_event_id: 'evt-2', person_email: 'rod@x.com' },
    { id: 3, project_id: 1, google_event_id: 'evt-3', person_email: 'rod@x.com' },
  ], [2]);
  const result = await cleanupExpiredHolds(undefined, deps);
  assert.equal(result.checked, 3);
  assert.equal(result.deleted, 3);
  assert.equal(result.google_errors, 1);
});

test('cleanup: connection null pula deleteEvent', async () => {
  const { deps } = makeDeps([
    { id: 1, project_id: 99, google_event_id: 'evt-x', person_email: 'rod@x.com' },
  ]);
  deps.getConnectionByProjectId = (async () => null) as typeof deps.getConnectionByProjectId;
  const result = await cleanupExpiredHolds(undefined, deps);
  assert.equal(result.deleted, 1);
  assert.equal(result.google_errors, 0);
});
