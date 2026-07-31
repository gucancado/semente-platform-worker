// tests/whatsapp/ai-pattern-store.test.ts  (PURO — fake pool, sem Postgres real)
//
// Prova o SHAPE do SQL e a orquestração do data layer do motor de IA nível 2
// (Task E1, spec v3 §3.2/§8): claim idempotente semanal (retomada só de 'failed'),
// finish/fail de run, dedupe de sugestão pendente por (workspace, kind), insight
// livre (1-por-run é convenção do chamador, não constraint), leitura/resolução de
// sugestões. A correção contra Postgres real (UNIQUE, CHECKs, FK) é do
// ai-pattern-store.db.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import {
  claimPatternRun,
  finishPatternRun,
  failPatternRun,
  insertSuggestion,
  insertInsight,
  listPendingSuggestions,
  resolveSuggestion,
  getSuggestion,
  listInsights,
} from '../../src/whatsapp/ai-pattern-store.js';

type Handler = (params: any[]) => { rows: any[]; rowCount?: number };

function makeFakePool(handlers: Handler[]): { pool: Pool; calls: { sql: string; params: any[] }[] } {
  const calls: { sql: string; params: any[] }[] = [];
  let i = 0;
  const pool = {
    query: (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const h = handlers[i++];
      const res = h ? h(params) : { rows: [], rowCount: 0 };
      return Promise.resolve({ rows: res.rows, rowCount: res.rowCount ?? res.rows.length });
    },
  } as unknown as Pool;
  return { pool, calls };
}

// ── claimPatternRun ──────────────────────────────────────────────────────────

test('claimPatternRun: INSERT ganha o claim (row nova) → {runId, resumed:false}, 1 query só', async () => {
  const { pool, calls } = makeFakePool([
    () => ({ rows: [{ id: 7 }] }), // INSERT ... RETURNING id
  ]);
  const res = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  assert.deepEqual(res, { runId: 7, resumed: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO whatsapp_ai_pattern_runs/);
  assert.match(calls[0].sql, /ON CONFLICT \(workspace_id, period_start\) DO NOTHING/);
  assert.deepEqual(calls[0].params, ['ws-1', '2026-07-20', '2026-07-26']);
});

test('claimPatternRun: conflito + status=failed → SELECT então UPDATE pra running → resumed:true', async () => {
  const { pool, calls } = makeFakePool([
    () => ({ rows: [] }), // INSERT sem retorno (conflito)
    () => ({ rows: [{ id: 7, status: 'failed' }] }), // SELECT
    () => ({ rows: [{ id: 7 }] }), // UPDATE ... RETURNING id
  ]);
  const res = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  assert.deepEqual(res, { runId: 7, resumed: true });
  assert.equal(calls.length, 3);
  assert.match(calls[1].sql, /SELECT id, status FROM whatsapp_ai_pattern_runs/);
  assert.deepEqual(calls[1].params, ['ws-1', '2026-07-20']);
  assert.match(calls[2].sql, /UPDATE whatsapp_ai_pattern_runs/);
  assert.match(calls[2].sql, /status\s*=\s*'running'/);
  assert.match(calls[2].sql, /started_at\s*=\s*now\(\)/i);
  assert.match(calls[2].sql, /finished_at\s*=\s*NULL/i);
  assert.match(calls[2].sql, /WHERE id\s*=\s*\$1 AND status\s*=\s*'failed'/, 'UPDATE tem guard de status (fecha a corrida)');
  assert.deepEqual(calls[2].params, [7]);
});

test('claimPatternRun: retomada perde a corrida — UPDATE 0 rows (status já não é failed) → null, sem inventar runId', async () => {
  const { pool, calls } = makeFakePool([
    () => ({ rows: [] }), // INSERT conflito
    () => ({ rows: [{ id: 7, status: 'failed' }] }), // SELECT lê failed...
    () => ({ rows: [] }), // ...mas outra réplica já mudou o status entre o SELECT e o UPDATE
  ]);
  const res = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  assert.equal(res, null);
  assert.equal(calls.length, 3, 'chegou a tentar o UPDATE, mas perdeu');
  assert.match(calls[2].sql, /WHERE id\s*=\s*\$1 AND status\s*=\s*'failed'/);
});

test('claimPatternRun: conflito + status=running → null, sem UPDATE (não retoma run alheia em progresso)', async () => {
  const { pool, calls } = makeFakePool([
    () => ({ rows: [] }),
    () => ({ rows: [{ id: 7, status: 'running' }] }),
  ]);
  const res = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  assert.equal(res, null);
  assert.equal(calls.length, 2, 'não chama UPDATE');
});

test('claimPatternRun: conflito + status=done → null (semana já processada)', async () => {
  const { pool, calls } = makeFakePool([
    () => ({ rows: [] }),
    () => ({ rows: [{ id: 7, status: 'done' }] }),
  ]);
  const res = await claimPatternRun(pool, 'ws-1', '2026-07-20', '2026-07-26');
  assert.equal(res, null);
  assert.equal(calls.length, 2);
});

// ── finishPatternRun / failPatternRun ────────────────────────────────────────

test('finishPatternRun: UPDATE status=done + output serializado + finished_at=now()', async () => {
  const { pool, calls } = makeFakePool([() => ({ rows: [] })]);
  await finishPatternRun(pool, 7, { tagsCreated: 2, insightId: 3 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE whatsapp_ai_pattern_runs/);
  assert.match(calls[0].sql, /status\s*=\s*'done'/);
  assert.match(calls[0].sql, /finished_at\s*=\s*now\(\)/i);
  assert.deepEqual(calls[0].params, [7, JSON.stringify({ tagsCreated: 2, insightId: 3 })]);
});

test('finishPatternRun: output null vira JSON null explícito', async () => {
  const { pool, calls } = makeFakePool([() => ({ rows: [] })]);
  await finishPatternRun(pool, 7, null);
  assert.deepEqual(calls[0].params, [7, 'null']);
});

test('failPatternRun: UPDATE status=failed + finished_at=now(), sem mexer em output', async () => {
  const { pool, calls } = makeFakePool([() => ({ rows: [] })]);
  await failPatternRun(pool, 7);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE whatsapp_ai_pattern_runs/);
  assert.match(calls[0].sql, /status\s*=\s*'failed'/);
  assert.match(calls[0].sql, /finished_at\s*=\s*now\(\)/i);
  assert.equal(calls[0].sql.includes('output'), false, 'não toca output');
  assert.deepEqual(calls[0].params, [7]);
});

// ── insertSuggestion (dedupe atômico) ────────────────────────────────────────

test('insertSuggestion: nenhuma pendente do kind → INSERT ... WHERE NOT EXISTS retorna id', async () => {
  const { pool, calls } = makeFakePool([() => ({ rows: [{ id: 42 }] })]);
  const payload = { current: 'a', suggested: 'b', reason: 'r' };
  const id = await insertSuggestion(pool, 'ws-1', 'guidance_lead', payload);
  assert.equal(id, 42);
  assert.match(calls[0].sql, /INSERT INTO whatsapp_ai_suggestions/);
  assert.match(calls[0].sql, /WHERE NOT EXISTS/);
  assert.match(calls[0].sql, /status\s*=\s*'pending'/);
  assert.deepEqual(calls[0].params, ['ws-1', 'guidance_lead', JSON.stringify(payload)]);
});

test('insertSuggestion: já existe pendente do mesmo kind → WHERE NOT EXISTS não insere → null', async () => {
  const { pool } = makeFakePool([() => ({ rows: [] })]); // dedupe bloqueou
  const id = await insertSuggestion(pool, 'ws-1', 'guidance_qualified', { x: 1 });
  assert.equal(id, null);
});

test('insertSuggestion: corrida real (23505 unique_violation do índice parcial) → dedupe, retorna null', async () => {
  const { pool, calls } = makeFakePool([
    () => {
      const err: any = new Error('duplicate key value violates unique constraint "uq_ai_suggestions_pending"');
      err.code = '23505';
      throw err;
    },
  ]);
  const id = await insertSuggestion(pool, 'ws-1', 'guidance_lead', { a: 1 });
  assert.equal(id, null);
  assert.equal(calls.length, 1, 'não retenta nem faz query extra — só engole o erro');
});

test('insertSuggestion: erro que NÃO é 23505 propaga (não é engolido como dedupe)', async () => {
  const { pool } = makeFakePool([
    () => {
      const err: any = new Error('connection terminated unexpectedly');
      err.code = '57P01';
      throw err;
    },
  ]);
  await assert.rejects(
    () => insertSuggestion(pool, 'ws-1', 'guidance_lead', { a: 1 }),
    /connection terminated unexpectedly/,
  );
});

// ── insertInsight ─────────────────────────────────────────────────────────────

test('insertInsight: INSERT com run_id, summary e details serializados; retorna id', async () => {
  const { pool, calls } = makeFakePool([() => ({ rows: [{ id: 9 }] })]);
  const id = await insertInsight(pool, 'ws-1', 7, 'padrões da semana', { tagsCreated: ['bairro x'] });
  assert.equal(id, 9);
  assert.match(calls[0].sql, /INSERT INTO whatsapp_ai_insights/);
  assert.deepEqual(calls[0].params, ['ws-1', 7, 'padrões da semana', JSON.stringify({ tagsCreated: ['bairro x'] })]);
});

test('insertInsight: runId null e details omitido → params com null/null', async () => {
  const { pool, calls } = makeFakePool([() => ({ rows: [{ id: 10 }] })]);
  await insertInsight(pool, 'ws-1', null, 'sem run associado');
  assert.deepEqual(calls[0].params, ['ws-1', null, 'sem run associado', null]);
});

// ── listPendingSuggestions ────────────────────────────────────────────────────

test('listPendingSuggestions: filtra status=pending e mapeia snake_case → camelCase', async () => {
  const row = {
    id: 5, workspace_id: 'ws-1', kind: 'guidance_lead',
    payload: { current: 'a', suggested: 'b', reason: 'r' },
    status: 'pending', created_at: new Date('2026-07-27T10:00:00.000Z'),
    resolved_at: null, resolved_by: null,
  };
  const { pool, calls } = makeFakePool([() => ({ rows: [row] })]);
  const result = await listPendingSuggestions(pool, 'ws-1');
  assert.match(calls[0].sql, /FROM whatsapp_ai_suggestions/);
  assert.match(calls[0].sql, /status\s*=\s*'pending'/);
  assert.deepEqual(calls[0].params, ['ws-1']);
  assert.deepEqual(result, [{
    id: 5, workspaceId: 'ws-1', kind: 'guidance_lead',
    payload: { current: 'a', suggested: 'b', reason: 'r' },
    status: 'pending', createdAt: '2026-07-27T10:00:00.000Z',
    resolvedAt: null, resolvedBy: null,
  }]);
});

// ── resolveSuggestion ─────────────────────────────────────────────────────────

test('resolveSuggestion: applied → UPDATE status/resolved_at/resolved_by, WHERE status=pending', async () => {
  const row = {
    id: 5, workspace_id: 'ws-1', kind: 'guidance_lead', payload: { a: 1 },
    status: 'applied', created_at: new Date('2026-07-27T10:00:00.000Z'),
    resolved_at: new Date('2026-07-28T11:00:00.000Z'), resolved_by: 'user-uuid-1',
  };
  const { pool, calls } = makeFakePool([() => ({ rows: [row] })]);
  const result = await resolveSuggestion(pool, 5, 'applied', 'user-uuid-1');
  assert.match(calls[0].sql, /UPDATE whatsapp_ai_suggestions/);
  assert.match(calls[0].sql, /resolved_at\s*=\s*now\(\)/i);
  assert.match(calls[0].sql, /WHERE id\s*=\s*\$1 AND status\s*=\s*'pending'/);
  assert.deepEqual(calls[0].params, [5, 'applied', 'user-uuid-1']);
  assert.equal(result?.status, 'applied');
  assert.equal(result?.resolvedBy, 'user-uuid-1');
  assert.equal(result?.resolvedAt, '2026-07-28T11:00:00.000Z');
});

test('resolveSuggestion: id inexistente ou já resolvida → 0 rows → null', async () => {
  const { pool } = makeFakePool([() => ({ rows: [] })]);
  const result = await resolveSuggestion(pool, 999, 'dismissed', 'user-uuid-1');
  assert.equal(result, null);
});

// ── getSuggestion (Task E4) ────────────────────────────────────────────────────

test('getSuggestion: SELECT por id, sem filtro de workspace (rota decide o 404 cross-tenant)', async () => {
  const row = {
    id: 5, workspace_id: 'ws-1', kind: 'guidance_lead',
    payload: { current: 'a', suggested: 'b', reason: 'r' },
    status: 'pending', created_at: new Date('2026-07-27T10:00:00.000Z'),
    resolved_at: null, resolved_by: null,
  };
  const { pool, calls } = makeFakePool([() => ({ rows: [row] })]);
  const result = await getSuggestion(pool, 5);
  assert.match(calls[0].sql, /FROM whatsapp_ai_suggestions/);
  assert.match(calls[0].sql, /WHERE id\s*=\s*\$1/);
  assert.equal(calls[0].sql.includes('workspace_id ='), false);
  assert.deepEqual(calls[0].params, [5]);
  assert.equal(result?.workspaceId, 'ws-1');
});

test('getSuggestion: id inexistente → null', async () => {
  const { pool } = makeFakePool([() => ({ rows: [] })]);
  const result = await getSuggestion(pool, 999);
  assert.equal(result, null);
});

// ── listInsights (Task E4) ─────────────────────────────────────────────────────

test('listInsights: SELECT ordenado por run_at DESC, LIMIT, mapeia snake_case → camelCase', async () => {
  const row = {
    id: 3, workspace_id: 'ws-1', run_id: 7, run_at: new Date('2026-07-27T05:00:00.000Z'),
    summary: 'padrões da semana', details: { tagsCreated: ['bairro x'] },
  };
  const { pool, calls } = makeFakePool([() => ({ rows: [row] })]);
  const result = await listInsights(pool, 'ws-1', 5);
  assert.match(calls[0].sql, /FROM whatsapp_ai_insights/);
  assert.match(calls[0].sql, /ORDER BY run_at DESC/);
  assert.match(calls[0].sql, /LIMIT \$2/);
  assert.deepEqual(calls[0].params, ['ws-1', 5]);
  assert.deepEqual(result, [{
    id: 3, workspaceId: 'ws-1', runId: 7, runAt: '2026-07-27T05:00:00.000Z',
    summary: 'padrões da semana', details: { tagsCreated: ['bairro x'] },
  }]);
});

test('listInsights: workspace sem insights → []', async () => {
  const { pool } = makeFakePool([() => ({ rows: [] })]);
  const result = await listInsights(pool, 'ws-1', 5);
  assert.deepEqual(result, []);
});
