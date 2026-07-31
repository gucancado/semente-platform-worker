/**
 * tests/whatsapp/ai-pattern-store.db.test.ts  (roda no servidor/CI com DATABASE_URL)
 * SERVER-GATED: requires a live Postgres com a migration 055 aplicada. NUNCA contra prod.
 *
 * Prova as garantias que só Postgres real dá (UNIQUE, CHECK, dedupe atômico) pro data
 * layer do motor de IA nível 2 (Task E1, spec v3 §3.2/§8):
 *   1. claimPatternRun: 2ª chamada pro mesmo (workspace, period_start) não duplica a
 *      row (UNIQUE) e retorna null enquanto a 1ª segue 'running'.
 *   2. claimPatternRun retoma uma run 'failed' (não cria row nova).
 *   3. finishPatternRun/failPatternRun persistem de fato (status + finished_at).
 *   4. insertSuggestion: dedupe real contra a tabela — 2ª chamada com o mesmo kind
 *      pendente não insere; após resolver a 1ª, uma nova pendente pode ser criada.
 *   5. insertInsight + FK run_id; listPendingSuggestions/resolveSuggestion end-to-end.
 *   6. CHECKs do DDL (055): kind inválido e status inválido são rejeitados pelo banco.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import {
  claimPatternRun,
  finishPatternRun,
  failPatternRun,
  insertSuggestion,
  insertInsight,
  listPendingSuggestions,
  resolveSuggestion,
} from '../../src/whatsapp/ai-pattern-store.js';

const TRUNCATE = `TRUNCATE whatsapp_ai_insights, whatsapp_ai_suggestions, whatsapp_ai_pattern_runs RESTART IDENTITY CASCADE`;

beforeEach(async () => { await pool.query(TRUNCATE); });
after(() => pool.end());

test('claimPatternRun: claim único por (workspace, period_start) — 2ª chamada enquanto running → null', async () => {
  const first = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  assert.ok(first);
  assert.equal(first!.resumed, false);

  const second = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  assert.equal(second, null);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM whatsapp_ai_pattern_runs');
  assert.equal(rows[0].n, 1, 'não duplicou a row');
});

test('claimPatternRun: workspace diferente ou period_start diferente claima independentemente', async () => {
  const a = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  const b = await claimPatternRun(pool, 'ws-2', '2026-07-20', '2026-07-26');
  const c = await claimPatternRun(pool, 'ws-1', '2026-07-27', '2026-08-02');
  assert.ok(a && b && c);
  assert.notEqual(a!.runId, b!.runId);
  assert.notEqual(a!.runId, c!.runId);
});

test('claimPatternRun: retoma run failed (não cria row nova) e reseta finished_at', async () => {
  const first = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  await failPatternRun(pool, first!.runId);

  const resumed = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  assert.ok(resumed);
  assert.equal(resumed!.resumed, true);
  assert.equal(resumed!.runId, first!.runId, 'mesma row, não cria outra');

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM whatsapp_ai_pattern_runs');
  assert.equal(rows[0].n, 1);
  const row = await pool.query('SELECT status, finished_at FROM whatsapp_ai_pattern_runs WHERE id = $1', [first!.runId]);
  assert.equal(row.rows[0].status, 'running');
  assert.equal(row.rows[0].finished_at, null);
});

test('claimPatternRun: NÃO retoma run done (semana já processada)', async () => {
  const first = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  await finishPatternRun(pool, first!.runId, { ok: true });

  const again = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  assert.equal(again, null);
});

test('finishPatternRun: grava status=done, output e finished_at', async () => {
  const run = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  await finishPatternRun(pool, run!.runId, { tagsCreated: 2 });
  const { rows } = await pool.query('SELECT status, output, finished_at FROM whatsapp_ai_pattern_runs WHERE id = $1', [run!.runId]);
  assert.equal(rows[0].status, 'done');
  assert.deepEqual(rows[0].output, { tagsCreated: 2 });
  assert.ok(rows[0].finished_at != null);
});

test('failPatternRun: grava status=failed e finished_at', async () => {
  const run = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  await failPatternRun(pool, run!.runId);
  const { rows } = await pool.query('SELECT status, finished_at FROM whatsapp_ai_pattern_runs WHERE id = $1', [run!.runId]);
  assert.equal(rows[0].status, 'failed');
  assert.ok(rows[0].finished_at != null);
});

test('claimPatternRun: duas retomadas CONCORRENTES da mesma run failed — só uma vence (guard fecha a corrida)', async () => {
  const first = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  await failPatternRun(pool, first!.runId);

  const [a, b] = await Promise.all([
    claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26'),
    claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26'),
  ]);
  const winners = [a, b].filter((r) => r != null);
  assert.equal(winners.length, 1, 'sem o guard AND status=failed no UPDATE, as duas venceriam (2 calls LLM p/ a mesma run)');
  assert.equal(winners[0]!.runId, first!.runId);
  assert.equal(winners[0]!.resumed, true);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM whatsapp_ai_pattern_runs');
  assert.equal(rows[0].n, 1, 'segue 1 row só — nenhuma retomada cria row nova');
});

test('insertSuggestion: dedupe real — 2ª pendente do mesmo kind não é criada; após resolver, nova pode nascer', async () => {
  const id1 = await insertSuggestion(pool, 'ws-1', 'guidance_lead', { current: 'a', suggested: 'b', reason: 'r1' });
  assert.ok(id1 != null);

  const id2 = await insertSuggestion(pool, 'ws-1', 'guidance_lead', { current: 'a', suggested: 'c', reason: 'r2' });
  assert.equal(id2, null, 'dedupe bloqueou a 2ª pendente do mesmo kind');

  // kind diferente no MESMO workspace não é bloqueado pelo dedupe.
  const id3 = await insertSuggestion(pool, 'ws-1', 'guidance_qualified', { current: 'x', suggested: 'y', reason: 'r3' });
  assert.ok(id3 != null);

  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM whatsapp_ai_suggestions WHERE status = 'pending'`);
  assert.equal(rows[0].n, 2, 'só as 2 pendentes de kinds distintos — a 2ª tentativa do mesmo kind não gravou nada');

  await resolveSuggestion(pool, id1!, 'dismissed', 'user-1');
  const id4 = await insertSuggestion(pool, 'ws-1', 'guidance_lead', { current: 'a', suggested: 'd', reason: 'r4' });
  assert.ok(id4 != null, 'após resolver a pendente antiga, uma nova pode ser criada');
});

test('insertSuggestion: duas inserções CONCORRENTES do mesmo kind/workspace — só uma vence (índice único parcial + catch 23505)', async () => {
  const [a, b] = await Promise.all([
    insertSuggestion(pool, 'ws-1', 'guidance_lead', { current: 'a', suggested: 'x', reason: 'r' }),
    insertSuggestion(pool, 'ws-1', 'guidance_lead', { current: 'a', suggested: 'y', reason: 'r' }),
  ]);
  const winners = [a, b].filter((v) => v != null);
  assert.equal(winners.length, 1, 'sem o índice único parcial, o WHERE NOT EXISTS sozinho deixaria as duas passarem');

  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM whatsapp_ai_suggestions WHERE workspace_id='ws-1' AND kind='guidance_lead' AND status='pending'`);
  assert.equal(rows[0].n, 1);
});

test('insertInsight + FK run_id; listPendingSuggestions/resolveSuggestion end-to-end', async () => {
  const run = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  const insightId = await insertInsight(pool, 'ws-1', run!.runId, 'padrões da semana', { tagsCreated: ['bairro x'] });
  assert.ok(insightId > 0);

  await insertSuggestion(pool, 'ws-1', 'guidance_lead', { current: 'a', suggested: 'b', reason: 'r' });
  const pending = await listPendingSuggestions(pool, 'ws-1');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'pending');

  const resolved = await resolveSuggestion(pool, pending[0].id, 'applied', 'user-1');
  assert.equal(resolved?.status, 'applied');
  assert.equal(resolved?.resolvedBy, 'user-1');

  const pendingAfter = await listPendingSuggestions(pool, 'ws-1');
  assert.equal(pendingAfter.length, 0);
});

test('CHECK do DDL: kind inválido em whatsapp_ai_suggestions é rejeitado', async () => {
  await assert.rejects(
    pool.query(
      `INSERT INTO whatsapp_ai_suggestions (workspace_id, kind, payload) VALUES ('ws-1', 'bogus', '{}'::jsonb)`,
    ),
  );
});

test('CHECK do DDL: status inválido em whatsapp_ai_pattern_runs é rejeitado', async () => {
  await assert.rejects(
    pool.query(
      `INSERT INTO whatsapp_ai_pattern_runs (workspace_id, period_start, period_end, status)
       VALUES ('ws-1', '2026-07-20', '2026-07-26', 'bogus')`,
    ),
  );
});
