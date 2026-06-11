import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { runImport } from '../../src/cli/import-fireflies.js';
import type { FirefliesTranscript } from '../../src/integrations/fireflies/normalize.js';

const T1: FirefliesTranscript = {
  id: 'ff-1', title: 'Reunião Tagless', date: Date.parse('2026-05-01T14:00:00Z'), duration: 30,
  participants: ['g@beeads.com.br', 'ana@tagless.com.br'],
  sentences: [{ index: 0, speaker_name: 'Ana', text: 'Oi', start_time: 0, end_time: 1 }],
};
const T2: FirefliesTranscript = { ...T1, id: 'ff-2', title: 'Interna', participants: ['g@beeads.com.br'], sentences: [{ index: 0, speaker_name: 'G', text: 'x', start_time: 0, end_time: 1 }] };
const TVAZIO: FirefliesTranscript = { ...T1, id: 'ff-3', sentences: null };

function fakeSource(items: FirefliesTranscript[]) {
  return (async function* () { for (const t of items) yield t; })();
}

beforeEach(async () => {
  await pool.query('TRUNCATE episode_turns, episodes, event_outbox_deliveries, event_outbox, workspace_domains RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO workspace_domains (domain, workspace_id, project_slug) VALUES ('tagless.com.br','wks-tagless','tagless-brasil')`);
});
after(() => pool.end());

test('dry-run não grava nada e reporta', async () => {
  const report = await runImport(fakeSource([T1, T2, TVAZIO]), { dryRun: true, internalWorkspaceId: 'wks-interno' });
  assert.equal(report.total_seen, 3);
  assert.equal(report.imported, 0);
  assert.equal(report.skipped_empty, 1);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM episodes');
  assert.equal(rows[0].n, 0);
});

test('import real: atribui por domínio e interno; vazio é pulado; re-rodar é idempotente', async () => {
  const r1 = await runImport(fakeSource([T1, T2, TVAZIO]), { dryRun: false, internalWorkspaceId: 'wks-interno' });
  assert.equal(r1.imported, 2);
  assert.equal(r1.by_method.domain, 1);
  assert.equal(r1.by_method.internal, 1);
  assert.equal(r1.skipped_empty, 1);
  const r2 = await runImport(fakeSource([T1, T2]), { dryRun: false, internalWorkspaceId: 'wks-interno' });
  assert.equal(r2.imported, 0);
  assert.equal(r2.duplicates, 2);
});
