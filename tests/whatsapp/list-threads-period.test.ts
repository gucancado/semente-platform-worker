import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { listThreads } from '../../src/whatsapp/read-queries.js';

beforeEach(async () => {
  await pool.query(
    'TRUNCATE messages, whatsapp_numbers, whatsapp_thread_meta, whatsapp_groups, whatsapp_thread_tags RESTART IDENTITY CASCADE'
  );
});
after(() => pool.end());

// Helper: insert a whatsapp_number and messages at explicit timestamps.
// threads = [{ identifier, timestamps: string[] }]
async function seed(numberId: number, workspaceId: string, threads: { identifier: string; timestamps: string[] }[]) {
  await pool.query(
    `INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES ($1, $2, 'test-instance')`,
    [numberId, workspaceId]
  );
  for (const thread of threads) {
    for (const ts of thread.timestamps) {
      await pool.query(
        `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
         VALUES ($1, $2, 'whatsapp', $3, 'inbound', $3, $4::timestamptz)`,
        [numberId, workspaceId, thread.identifier, ts]
      );
    }
  }
}

// --- arrival mode ---

test('arrival: thread whose FIRST msg is INSIDE [since,until] appears', async () => {
  // +in: first msg 2026-01-10, second 2026-01-20 → min_created inside window
  // +out: first msg 2026-01-01 (before window), last msg 2026-01-15 (inside) → min_created OUTSIDE window
  await seed(80, 'ws-80', [
    { identifier: '+in',  timestamps: ['2026-01-10T00:00:00Z', '2026-01-20T00:00:00Z'] },
    { identifier: '+out', timestamps: ['2026-01-01T00:00:00Z', '2026-01-15T00:00:00Z'] },
  ]);

  const result = await listThreads(pool, {
    workspaceId: 'ws-80',
    numberId: 80,
    limit: 10,
    since: '2026-01-05T00:00:00Z',
    until: '2026-01-31T00:00:00Z',
    periodBasis: 'arrival',
  });

  const ids = result.threads.map(t => t.identifier);
  assert.ok(ids.includes('+in'), `Expected +in in results, got: ${ids}`);
  assert.ok(!ids.includes('+out'), `Expected +out to be excluded, got: ${ids}`);
});

test('arrival: thread whose FIRST msg is OUTSIDE [since,until] but LAST is INSIDE must NOT appear', async () => {
  await seed(81, 'ws-81', [
    { identifier: '+late-arrival', timestamps: ['2026-01-01T00:00:00Z', '2026-01-20T00:00:00Z'] },
  ]);

  const result = await listThreads(pool, {
    workspaceId: 'ws-81',
    numberId: 81,
    limit: 10,
    since: '2026-01-10T00:00:00Z',
    until: '2026-01-31T00:00:00Z',
    periodBasis: 'arrival',
  });

  assert.equal(result.threads.length, 0, 'Thread with first msg before window must be excluded in arrival mode');
});

test('arrival pagination stability: page1 + page2 = exactly the in-window threads, ordered by min_created DESC, no leakage', async () => {
  // 3 threads with first-msg inside window [2026-01-10, 2026-01-31]
  // 1 thread with first-msg outside (should never appear)
  await seed(82, 'ws-82', [
    { identifier: '+a', timestamps: ['2026-01-10T00:00:00Z', '2026-01-25T00:00:00Z'] }, // min=10
    { identifier: '+b', timestamps: ['2026-01-15T00:00:00Z', '2026-01-22T00:00:00Z'] }, // min=15
    { identifier: '+c', timestamps: ['2026-01-20T00:00:00Z'] },                          // min=20
    { identifier: '+x', timestamps: ['2025-12-01T00:00:00Z', '2026-01-25T00:00:00Z'] }, // min outside
  ]);

  const since = '2026-01-05T00:00:00Z';
  const until = '2026-01-31T23:59:59Z';

  // page1: limit=2 → should return +c (min=20), +b (min=15) ordered by min_created DESC
  const page1 = await listThreads(pool, {
    workspaceId: 'ws-82',
    numberId: 82,
    limit: 2,
    since,
    until,
    periodBasis: 'arrival',
  });

  assert.equal(page1.threads.length, 2, `page1 should have 2 threads, got ${page1.threads.length}`);
  assert.equal(page1.threads[0].identifier, '+c', `page1[0] should be +c (min=20), got ${page1.threads[0].identifier}`);
  assert.equal(page1.threads[1].identifier, '+b', `page1[1] should be +b (min=15), got ${page1.threads[1].identifier}`);
  assert.ok(page1.nextCursor, 'page1 should have nextCursor');

  // page2: should return +a (min=10), no leakage of +x
  const page2 = await listThreads(pool, {
    workspaceId: 'ws-82',
    numberId: 82,
    limit: 2,
    cursor: page1.nextCursor!,
    since,
    until,
    periodBasis: 'arrival',
  });

  assert.equal(page2.threads.length, 1, `page2 should have exactly 1 thread, got ${page2.threads.length}: ${page2.threads.map(t => t.identifier)}`);
  assert.equal(page2.threads[0].identifier, '+a', `page2[0] should be +a, got ${page2.threads[0].identifier}`);
  assert.equal(page2.nextCursor, null, 'page2 should have no nextCursor');

  // combined: no duplicates, no leakage
  const allIds = [...page1.threads, ...page2.threads].map(t => t.identifier);
  assert.deepEqual(allIds.sort(), ['+a', '+b', '+c']);
  assert.ok(!allIds.includes('+x'), 'Thread +x (first msg outside window) must never appear in arrival mode');
});

// --- activity mode ---

test('activity: thread with ANY message in window appears (including late-arrival that arrival excludes)', async () => {
  // +late-arrival: first msg before window, last msg inside → activity should include it
  await seed(83, 'ws-83', [
    { identifier: '+late-arrival', timestamps: ['2026-01-01T00:00:00Z', '2026-01-20T00:00:00Z'] },
    { identifier: '+early-only',   timestamps: ['2026-01-01T00:00:00Z'] }, // no msg in window → excluded
  ]);

  const result = await listThreads(pool, {
    workspaceId: 'ws-83',
    numberId: 83,
    limit: 10,
    since: '2026-01-10T00:00:00Z',
    until: '2026-01-31T00:00:00Z',
    periodBasis: 'activity',
  });

  const ids = result.threads.map(t => t.identifier);
  assert.ok(ids.includes('+late-arrival'), `+late-arrival should appear in activity mode, got: ${ids}`);
  assert.ok(!ids.includes('+early-only'), `+early-only (no msg in window) should be excluded, got: ${ids}`);
});

// --- no window (omit since/until) ---

test('no window: result equals current behavior (all threads, last_at order, cursor still works)', async () => {
  await seed(84, 'ws-84', [
    { identifier: '+oldest', timestamps: ['2026-01-01T00:00:00Z'] },
    { identifier: '+middle', timestamps: ['2026-01-05T00:00:00Z'] },
    { identifier: '+newest', timestamps: ['2026-01-10T00:00:00Z'] },
  ]);

  // No since/until → should return all threads, ordered by last_at DESC
  const page1 = await listThreads(pool, {
    workspaceId: 'ws-84',
    numberId: 84,
    limit: 2,
  });

  assert.equal(page1.threads.length, 2);
  assert.equal(page1.threads[0].identifier, '+newest', 'First should be newest by last_at');
  assert.equal(page1.threads[1].identifier, '+middle');
  assert.ok(page1.nextCursor, 'should have nextCursor');

  const page2 = await listThreads(pool, {
    workspaceId: 'ws-84',
    numberId: 84,
    limit: 2,
    cursor: page1.nextCursor!,
  });

  assert.equal(page2.threads.length, 1);
  assert.equal(page2.threads[0].identifier, '+oldest');
  assert.equal(page2.nextCursor, null);
});

test('no window with explicit periodBasis=arrival: behaves like no-window (all threads, last_at order)', async () => {
  // When hasWindow=false, even arrival mode should use last_at (backward compat)
  await seed(85, 'ws-85', [
    { identifier: '+alpha', timestamps: ['2026-01-01T00:00:00Z', '2026-01-20T00:00:00Z'] },
    { identifier: '+beta',  timestamps: ['2026-01-05T00:00:00Z'] },
  ]);

  const result = await listThreads(pool, {
    workspaceId: 'ws-85',
    numberId: 85,
    limit: 10,
    periodBasis: 'arrival', // no since/until → no window → last_at order
  });

  // +alpha has last_at=2026-01-20, +beta has last_at=2026-01-05 → +alpha first
  assert.equal(result.threads[0].identifier, '+alpha');
  assert.equal(result.threads[1].identifier, '+beta');
});
