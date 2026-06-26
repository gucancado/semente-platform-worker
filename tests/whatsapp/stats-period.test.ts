/**
 * tests/whatsapp/stats-period.test.ts
 *
 * SERVER-GATED: requires a live Postgres (DATABASE_URL). Cannot run locally without DB.
 * Local gate: pnpm typecheck (verifies types only).
 *
 * Covers:
 *   - arrival basis: thread whose FIRST msg is outside window is excluded
 *   - arrival basis: thread whose first msg is inside window is included
 *   - activity basis: thread with ANY msg inside window is included (even if first is outside)
 *   - no window (omit since/until): returns all threads (current behavior)
 *   - byTemperature / bySource: null bucket + known values
 *   - byIngestSource stays message-level: counts msgs in window, not threads
 *   - zero-fill: empty workspace → total 0, zero-fill counts, empty records for new buckets
 *   - periodBasis default: omitting periodBasis behaves as 'arrival'
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { getStats } from '../../src/whatsapp/stats.js';

const TRUNCATE = `TRUNCATE messages, whatsapp_numbers, whatsapp_thread_meta, whatsapp_groups, whatsapp_thread_tags RESTART IDENTITY CASCADE`;

beforeEach(async () => { await pool.query(TRUNCATE); });
after(() => pool.end());

// Helper: insert a whatsapp_number and return its id.
async function insertNumber(id: number, workspaceId: string): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES ($1, $2, $3)`,
    [id, workspaceId, `inst-${id}`],
  );
}

// Helper: insert a message with an explicit created_at.
async function insertMsg(opts: {
  numberId: number;
  workspaceId: string;
  identifier: string;
  createdAt: string; // ISO timestamp
  ingestSource?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, ingest_source, created_at)
     VALUES ($1, $2, 'whatsapp', $3, 'inbound', 'msg', $4, $5)`,
    [opts.numberId, opts.workspaceId, opts.identifier, opts.ingestSource ?? 'live', opts.createdAt],
  );
}

// ── arrival basis ──────────────────────────────────────────────────────────────

test('arrival: thread whose first msg is outside window is excluded', async () => {
  await insertNumber(1, 'ws-arr');

  // thread A: first msg 2024-01-01 (outside window), second msg 2024-06-15 (inside)
  await insertMsg({ numberId: 1, workspaceId: 'ws-arr', identifier: 'thread-A', createdAt: '2024-01-01T00:00:00Z' });
  await insertMsg({ numberId: 1, workspaceId: 'ws-arr', identifier: 'thread-A', createdAt: '2024-06-15T00:00:00Z' });

  // thread B: first msg 2024-06-01 (inside window)
  await insertMsg({ numberId: 1, workspaceId: 'ws-arr', identifier: 'thread-B', createdAt: '2024-06-01T00:00:00Z' });

  const stats = await getStats(pool, {
    workspaceId: 'ws-arr',
    numberId: 1,
    since: '2024-05-01T00:00:00Z',
    until: '2024-07-01T00:00:00Z',
    periodBasis: 'arrival',
  });

  // Only thread-B qualifies (first msg in window); thread-A's first msg is before window
  assert.equal(stats.total, 1, 'arrival: only thread-B counted');
  assert.equal(stats.byLeadStatus.lead, 1);
  assert.equal(stats.byLeadStatus.not_lead, 0);
  assert.equal(stats.byKind.dm, 1);
});

test('arrival: thread whose first msg is inside window is included', async () => {
  await insertNumber(2, 'ws-arr2');

  // thread X: first msg 2024-06-10 (inside window)
  await insertMsg({ numberId: 2, workspaceId: 'ws-arr2', identifier: 'thread-X', createdAt: '2024-06-10T00:00:00Z' });
  await insertMsg({ numberId: 2, workspaceId: 'ws-arr2', identifier: 'thread-X', createdAt: '2024-06-20T00:00:00Z' });

  const stats = await getStats(pool, {
    workspaceId: 'ws-arr2',
    numberId: 2,
    since: '2024-06-01T00:00:00Z',
    until: '2024-07-01T00:00:00Z',
    periodBasis: 'arrival',
  });

  assert.equal(stats.total, 1, 'arrival: thread-X counted (first msg in window)');
});

// ── activity basis ─────────────────────────────────────────────────────────────

test('activity: thread with any msg in window is counted, even if first is outside', async () => {
  await insertNumber(3, 'ws-act');

  // thread A: first msg before window, second msg inside window
  await insertMsg({ numberId: 3, workspaceId: 'ws-act', identifier: 'thread-A', createdAt: '2024-01-01T00:00:00Z' });
  await insertMsg({ numberId: 3, workspaceId: 'ws-act', identifier: 'thread-A', createdAt: '2024-06-15T00:00:00Z' });

  // thread B: first msg inside window
  await insertMsg({ numberId: 3, workspaceId: 'ws-act', identifier: 'thread-B', createdAt: '2024-06-05T00:00:00Z' });

  // thread C: entirely outside window
  await insertMsg({ numberId: 3, workspaceId: 'ws-act', identifier: 'thread-C', createdAt: '2024-01-15T00:00:00Z' });

  const stats = await getStats(pool, {
    workspaceId: 'ws-act',
    numberId: 3,
    since: '2024-05-01T00:00:00Z',
    until: '2024-07-01T00:00:00Z',
    periodBasis: 'activity',
  });

  // A and B qualify (each has at least one msg in window); C does not
  assert.equal(stats.total, 2, 'activity: thread-A and thread-B counted');
});

test('activity: contrast with arrival — same data, arrival gives fewer results', async () => {
  await insertNumber(4, 'ws-contrast');

  // thread A: first msg outside, later msg inside
  await insertMsg({ numberId: 4, workspaceId: 'ws-contrast', identifier: 'thread-A', createdAt: '2024-01-01T00:00:00Z' });
  await insertMsg({ numberId: 4, workspaceId: 'ws-contrast', identifier: 'thread-A', createdAt: '2024-06-15T00:00:00Z' });

  // thread B: first msg inside
  await insertMsg({ numberId: 4, workspaceId: 'ws-contrast', identifier: 'thread-B', createdAt: '2024-06-05T00:00:00Z' });

  const since = '2024-05-01T00:00:00Z';
  const until = '2024-07-01T00:00:00Z';

  const arrStats = await getStats(pool, { workspaceId: 'ws-contrast', numberId: 4, since, until, periodBasis: 'arrival' });
  const actStats = await getStats(pool, { workspaceId: 'ws-contrast', numberId: 4, since, until, periodBasis: 'activity' });

  assert.equal(arrStats.total, 1, 'arrival: only thread-B (first msg in window)');
  assert.equal(actStats.total, 2, 'activity: both threads (A has later msg in window)');
});

// ── no window ──────────────────────────────────────────────────────────────────

test('no window (omit since/until): returns all threads', async () => {
  await insertNumber(5, 'ws-nowin');

  await insertMsg({ numberId: 5, workspaceId: 'ws-nowin', identifier: 'thread-1', createdAt: '2020-01-01T00:00:00Z' });
  await insertMsg({ numberId: 5, workspaceId: 'ws-nowin', identifier: 'thread-2', createdAt: '2023-06-01T00:00:00Z' });
  await insertMsg({ numberId: 5, workspaceId: 'ws-nowin', identifier: 'thread-3', createdAt: '2025-12-31T00:00:00Z' });

  const stats = await getStats(pool, {
    workspaceId: 'ws-nowin',
    numberId: 5,
    // no since / until
  });

  assert.equal(stats.total, 3, 'no window: all 3 threads counted');
});

// ── periodBasis default ────────────────────────────────────────────────────────

test('periodBasis default: omitting periodBasis behaves as arrival', async () => {
  await insertNumber(6, 'ws-def');

  // Same setup as arrival test: first msg outside, second inside
  await insertMsg({ numberId: 6, workspaceId: 'ws-def', identifier: 'thread-A', createdAt: '2024-01-01T00:00:00Z' });
  await insertMsg({ numberId: 6, workspaceId: 'ws-def', identifier: 'thread-A', createdAt: '2024-06-15T00:00:00Z' });
  await insertMsg({ numberId: 6, workspaceId: 'ws-def', identifier: 'thread-B', createdAt: '2024-06-05T00:00:00Z' });

  const defaultStats = await getStats(pool, {
    workspaceId: 'ws-def',
    numberId: 6,
    since: '2024-05-01T00:00:00Z',
    until: '2024-07-01T00:00:00Z',
    // periodBasis omitted → defaults to 'arrival'
  });

  const arrivalStats = await getStats(pool, {
    workspaceId: 'ws-def',
    numberId: 6,
    since: '2024-05-01T00:00:00Z',
    until: '2024-07-01T00:00:00Z',
    periodBasis: 'arrival',
  });

  assert.equal(defaultStats.total, arrivalStats.total, 'default behaves as arrival');
  assert.equal(defaultStats.total, 1, 'default/arrival: only thread-B counted');
});

// ── byTemperature / bySource ──────────────────────────────────────────────────

test('byTemperature: known values + null bucket', async () => {
  await insertNumber(7, 'ws-temp');

  // thread A: quente
  await insertMsg({ numberId: 7, workspaceId: 'ws-temp', identifier: 'thread-A', createdAt: '2024-06-01T00:00:00Z' });
  await pool.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, lead_temperature)
     VALUES (7, 'thread-A', 'quente')
     ON CONFLICT (whatsapp_number_id, identifier) DO UPDATE SET lead_temperature = EXCLUDED.lead_temperature`,
  );

  // thread B: frio
  await insertMsg({ numberId: 7, workspaceId: 'ws-temp', identifier: 'thread-B', createdAt: '2024-06-02T00:00:00Z' });
  await pool.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, lead_temperature)
     VALUES (7, 'thread-B', 'frio')
     ON CONFLICT (whatsapp_number_id, identifier) DO UPDATE SET lead_temperature = EXCLUDED.lead_temperature`,
  );

  // thread C: no meta row → null bucket
  await insertMsg({ numberId: 7, workspaceId: 'ws-temp', identifier: 'thread-C', createdAt: '2024-06-03T00:00:00Z' });

  // thread D: morno (outside window — should be excluded under arrival)
  await insertMsg({ numberId: 7, workspaceId: 'ws-temp', identifier: 'thread-D', createdAt: '2024-01-01T00:00:00Z' });
  await pool.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, lead_temperature)
     VALUES (7, 'thread-D', 'morno')
     ON CONFLICT (whatsapp_number_id, identifier) DO UPDATE SET lead_temperature = EXCLUDED.lead_temperature`,
  );

  const stats = await getStats(pool, {
    workspaceId: 'ws-temp',
    numberId: 7,
    since: '2024-05-01T00:00:00Z',
    until: '2024-07-01T00:00:00Z',
    periodBasis: 'arrival',
  });

  // 3 threads in window (A, B, C); D is excluded
  assert.equal(stats.total, 3, 'byTemperature: 3 threads in window');
  assert.equal(stats.byTemperature['quente'], 1);
  assert.equal(stats.byTemperature['frio'], 1);
  assert.equal(stats.byTemperature['null'], 1, 'null bucket: thread-C with no meta');
  assert.equal(stats.byTemperature['morno'], undefined, 'morno excluded (thread-D outside window)');

  // All 3 buckets must sum to total
  const tempSum = Object.values(stats.byTemperature).reduce((a, b) => a + b, 0);
  assert.equal(tempSum, stats.total, 'byTemperature values sum to total');
});

test('bySource: known values + null bucket', async () => {
  await insertNumber(8, 'ws-src');

  // thread A: source = 'instagram'
  await insertMsg({ numberId: 8, workspaceId: 'ws-src', identifier: 'thread-A', createdAt: '2024-06-01T00:00:00Z' });
  await pool.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, lead_source)
     VALUES (8, 'thread-A', 'instagram')
     ON CONFLICT (whatsapp_number_id, identifier) DO UPDATE SET lead_source = EXCLUDED.lead_source`,
  );

  // thread B: no meta row → null bucket
  await insertMsg({ numberId: 8, workspaceId: 'ws-src', identifier: 'thread-B', createdAt: '2024-06-02T00:00:00Z' });

  // thread C: source = 'indicacao'
  await insertMsg({ numberId: 8, workspaceId: 'ws-src', identifier: 'thread-C', createdAt: '2024-06-03T00:00:00Z' });
  await pool.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, lead_source)
     VALUES (8, 'thread-C', 'indicacao')
     ON CONFLICT (whatsapp_number_id, identifier) DO UPDATE SET lead_source = EXCLUDED.lead_source`,
  );

  const stats = await getStats(pool, {
    workspaceId: 'ws-src',
    numberId: 8,
    // no window — all threads
  });

  assert.equal(stats.total, 3);
  assert.equal(stats.bySource['instagram'], 1);
  assert.equal(stats.bySource['indicacao'], 1);
  assert.equal(stats.bySource['null'], 1, 'null bucket: thread-B with no meta');

  const srcSum = Object.values(stats.bySource).reduce((a, b) => a + b, 0);
  assert.equal(srcSum, stats.total, 'bySource values sum to total');
});

// ── byIngestSource stays message-level ────────────────────────────────────────

test('byIngestSource is message-level and may diverge from thread count under a window', async () => {
  await insertNumber(9, 'ws-ingest');

  // thread A: 2 msgs live (one inside window, one outside), 1 msg backfill (inside)
  await insertMsg({ numberId: 9, workspaceId: 'ws-ingest', identifier: 'thread-A', createdAt: '2024-01-01T00:00:00Z', ingestSource: 'live' }); // outside window
  await insertMsg({ numberId: 9, workspaceId: 'ws-ingest', identifier: 'thread-A', createdAt: '2024-06-10T00:00:00Z', ingestSource: 'live' }); // inside
  await insertMsg({ numberId: 9, workspaceId: 'ws-ingest', identifier: 'thread-A', createdAt: '2024-06-15T00:00:00Z', ingestSource: 'backfill' }); // inside

  // thread B: first msg inside window (live)
  await insertMsg({ numberId: 9, workspaceId: 'ws-ingest', identifier: 'thread-B', createdAt: '2024-06-05T00:00:00Z', ingestSource: 'live' });

  const stats = await getStats(pool, {
    workspaceId: 'ws-ingest',
    numberId: 9,
    since: '2024-05-01T00:00:00Z',
    until: '2024-07-01T00:00:00Z',
    periodBasis: 'arrival', // thread-A excluded (first msg Jan)
  });

  // arrival: only thread-B (first msg in window)
  assert.equal(stats.total, 1, 'arrival: only thread-B (first msg in window)');

  // byIngestSource is message-level: counts msgs with created_at in window
  // thread-A inside-window msgs: 1 live + 1 backfill
  // thread-B inside-window msgs: 1 live
  // total: live=2, backfill=1 → diverges from thread total (1)
  assert.equal(stats.byIngestSource['live'], 2, 'byIngestSource[live] = 2 messages in window');
  assert.equal(stats.byIngestSource['backfill'], 1, 'byIngestSource[backfill] = 1 message in window');

  // This divergence is intentional: byIngestSource is message-level, not thread-level
  const ingestTotal = Object.values(stats.byIngestSource).reduce((a, b) => a + b, 0);
  assert.ok(ingestTotal !== stats.total, 'byIngestSource diverges from thread total (message vs thread granularity)');
});

// ── zero-fill ─────────────────────────────────────────────────────────────────

test('zero-fill: empty workspace → zeros and empty records', async () => {
  // No inserts at all for this workspace
  const stats = await getStats(pool, {
    workspaceId: 'ws-empty-999',
  });

  assert.equal(stats.total, 0);
  assert.equal(stats.byLeadStatus.lead, 0);
  assert.equal(stats.byLeadStatus.not_lead, 0);
  assert.equal(stats.byKind.dm, 0);
  assert.equal(stats.byKind.group, 0);
  assert.deepEqual(stats.byStage, {}, 'byStage empty for empty workspace');
  assert.deepEqual(stats.byTemperature, {}, 'byTemperature empty for empty workspace');
  assert.deepEqual(stats.bySource, {}, 'bySource empty for empty workspace');
  assert.deepEqual(stats.byIngestSource, {}, 'byIngestSource empty for empty workspace');
  assert.deepEqual(stats.byTag, {}, 'byTag empty for empty workspace');
});

// ── open bounds (one side null) ───────────────────────────────────────────────

test('open lower bound (since=null, until set): threads arriving at or before until', async () => {
  await insertNumber(10, 'ws-open');

  await insertMsg({ numberId: 10, workspaceId: 'ws-open', identifier: 'thread-A', createdAt: '2024-01-01T00:00:00Z' }); // before until
  await insertMsg({ numberId: 10, workspaceId: 'ws-open', identifier: 'thread-B', createdAt: '2024-06-01T00:00:00Z' }); // before until
  await insertMsg({ numberId: 10, workspaceId: 'ws-open', identifier: 'thread-C', createdAt: '2024-12-01T00:00:00Z' }); // after until

  const stats = await getStats(pool, {
    workspaceId: 'ws-open',
    numberId: 10,
    until: '2024-07-01T00:00:00Z',
    periodBasis: 'arrival',
  });

  assert.equal(stats.total, 2, 'open lower bound: thread-A and thread-B counted');
});

test('open upper bound (since set, until=null): threads arriving at or after since', async () => {
  await insertNumber(11, 'ws-open2');

  await insertMsg({ numberId: 11, workspaceId: 'ws-open2', identifier: 'thread-A', createdAt: '2024-01-01T00:00:00Z' }); // before since
  await insertMsg({ numberId: 11, workspaceId: 'ws-open2', identifier: 'thread-B', createdAt: '2024-06-01T00:00:00Z' }); // after since
  await insertMsg({ numberId: 11, workspaceId: 'ws-open2', identifier: 'thread-C', createdAt: '2024-12-01T00:00:00Z' }); // after since

  const stats = await getStats(pool, {
    workspaceId: 'ws-open2',
    numberId: 11,
    since: '2024-05-01T00:00:00Z',
    periodBasis: 'arrival',
  });

  assert.equal(stats.total, 2, 'open upper bound: thread-B and thread-C counted');
});
