import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { runFirefliesImportTick } from '../../src/integrations/fireflies/import-cron.js';
import type { ImportReport } from '../../src/cli/import-fireflies.js';

// ─────────────────────────────────────────────────────────────────────────
// Cron diário do import Fireflies (Task 1). Clock e runImportFn INJETADOS —
// nenhum teste toca a rede real do Fireflies. DB real (claim em
// fireflies_import_runs).
//
// Fixtures de relogio (SP = UTC-3, sem DST):
//   UTC 2026-07-20T07:30:00Z -> 04:30 SP (DENTRO — hour=4)
//   UTC 2026-07-20T15:00:00Z -> 12:00 SP (FORA)
// ─────────────────────────────────────────────────────────────────────────

const TICK_IN = '2026-07-20T07:30:00Z'; // 04:30 SP
const OUT_OF_WINDOW = '2026-07-20T15:00:00Z'; // 12:00 SP

function fakeReport(overrides: Partial<ImportReport> = {}): ImportReport {
  return {
    total_seen: 3,
    imported: 2,
    duplicates: 1,
    forced: 0,
    skipped_empty: 0,
    failed: [],
    by_method: { domain: 2 },
    orphans: [],
    unresolved_domains: {},
    no_audio: 1,
    ...overrides,
  };
}

beforeEach(async () => {
  await pool.query(
    'TRUNCATE episode_turns, episodes, fireflies_import_runs RESTART IDENTITY CASCADE'
  );
});
after(() => pool.end());

test('enabled=false → no-op, zero linhas em fireflies_import_runs', async () => {
  const result = await runFirefliesImportTick({
    enabled: false,
    hour: 4,
    apiKey: 'fake-key',
    now: () => new Date(TICK_IN),
    runImportFn: async () => fakeReport(),
  });
  assert.deepEqual(result, { ran: false, reason: 'disabled' });
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM fireflies_import_runs');
  assert.equal(rows[0].n, 0);
});

test('sem apiKey → no_api_key', async () => {
  const result = await runFirefliesImportTick({
    enabled: true,
    hour: 4,
    apiKey: undefined,
    now: () => new Date(TICK_IN),
    runImportFn: async () => fakeReport(),
  });
  assert.deepEqual(result, { ran: false, reason: 'no_api_key' });
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM fireflies_import_runs');
  assert.equal(rows[0].n, 0);
});

test('hora local ≠ hour configurada → outside_window', async () => {
  const result = await runFirefliesImportTick({
    enabled: true,
    hour: 4,
    apiKey: 'fake-key',
    now: () => new Date(OUT_OF_WINDOW),
    runImportFn: async () => fakeReport(),
  });
  assert.deepEqual(result, { ran: false, reason: 'outside_window' });
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM fireflies_import_runs');
  assert.equal(rows[0].n, 0);
});

test('tick válido sem episódios fireflies prévios → ran:true, fromDate undefined, stats gravadas', async () => {
  let receivedFromDate: string | undefined = 'não chamado' as unknown as string;
  const report = fakeReport();
  const result = await runFirefliesImportTick({
    enabled: true,
    hour: 4,
    apiKey: 'fake-key',
    now: () => new Date(TICK_IN),
    runImportFn: async (opts) => {
      receivedFromDate = opts.fromDate;
      return report;
    },
  });
  assert.equal(result.ran, true);
  if (!result.ran) throw new Error('unreachable');
  assert.equal(receivedFromDate, undefined);
  assert.deepEqual(result.report, report);

  const { rows } = await pool.query(
    'SELECT status, stats FROM fireflies_import_runs WHERE id = $1',
    [result.runId]
  );
  assert.equal(rows[0].status, 'done');
  const stats = rows[0].stats;
  assert.equal(stats.total_seen, report.total_seen);
  assert.equal(stats.imported, report.imported);
  assert.equal(stats.duplicates, report.duplicates);
  assert.equal(stats.skipped_empty, report.skipped_empty);
  assert.equal(stats.failed, report.failed.length);
  assert.deepEqual(stats.by_method, report.by_method);
  assert.equal(stats.orphans, report.orphans.length);
  assert.equal(stats.no_audio, report.no_audio);
  assert.equal(typeof stats.duration_ms, 'number');
});

test('com episódio fireflies prévio → fake recebe fromDate = occurred_at - 3 dias', async () => {
  const occurredAt = '2026-07-10T12:00:00Z';
  await pool.query(
    `INSERT INTO episodes (fonte, external_source, external_id, occurred_at)
     VALUES ('reuniao', 'fireflies', 'ff-seed', $1)`,
    [occurredAt]
  );

  let receivedFromDate: string | undefined;
  await runFirefliesImportTick({
    enabled: true,
    hour: 4,
    apiKey: 'fake-key',
    now: () => new Date(TICK_IN),
    runImportFn: async (opts) => {
      receivedFromDate = opts.fromDate;
      return fakeReport();
    },
  });

  const expected = new Date(Date.parse(occurredAt) - 3 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(receivedFromDate, expected);
});

test('segundo tick no mesmo dia (mesmo now) → already_claimed, continua UMA linha só', async () => {
  const first = await runFirefliesImportTick({
    enabled: true,
    hour: 4,
    apiKey: 'fake-key',
    now: () => new Date(TICK_IN),
    runImportFn: async () => fakeReport(),
  });
  assert.equal(first.ran, true);

  const second = await runFirefliesImportTick({
    enabled: true,
    hour: 4,
    apiKey: 'fake-key',
    now: () => new Date(TICK_IN),
    runImportFn: async () => fakeReport(),
  });
  assert.deepEqual(second, { ran: false, reason: 'already_claimed' });

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM fireflies_import_runs');
  assert.equal(rows[0].n, 1);
});

test('runImportFn que lança → linha vira failed com error preenchido, tick relança', async () => {
  await assert.rejects(
    () =>
      runFirefliesImportTick({
        enabled: true,
        hour: 4,
        apiKey: 'fake-key',
        now: () => new Date(TICK_IN),
        runImportFn: async () => {
          throw new Error('boom fireflies');
        },
      }),
    /boom fireflies/
  );

  const { rows } = await pool.query(
    'SELECT status, error FROM fireflies_import_runs ORDER BY id DESC LIMIT 1'
  );
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].error, 'boom fireflies');
});
