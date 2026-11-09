// tests/whatsapp/ai-pattern-apply.test.ts  (PURO — fake pool routeado por marcador + deps injetados)
//
// Prova a ORQUESTRAÇÃO do aplicador do motor de IA nível 2 (Task E3, spec v3 §8):
//   - tags: NUNCA escreve em whatsapp_tags; sugestão de tag vira suggestion kind='tag_new';
//   - motivos de perda novos (code = slug do label) e editados (guard);
//   - guidance → insertSuggestion {current, suggested, reason} (dedupe → skip);
//   - insight → insertInsight (runId); backfill de loss_reason = skip note (não implementado).
// A correção do SQL real (ON CONFLICT, guard) é do .db.test; aqui pool/lock/sticky/store
// são fakes injetados.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { applyPatternDecision, type ApplyPatternDeps } from '../../src/whatsapp/ai-pattern-apply.js';
import { TAG_COLORS } from '../../src/whatsapp/tags.js';
import type { PatternContext } from '../../src/whatsapp/ai-pattern-context.js';
import type { PatternDecision } from '../../src/whatsapp/ai-pattern-prompt.js';
import type { StickyFlags } from '../../src/whatsapp/ai-sticky.js';

const NO_STICKY: StickyFlags = { isLead: false, isQualified: false, status: false, lossReason: false, tagsRemovedByHuman: [] };

// ── roteamento por marcador de SQL ──────────────────────────────────────────────
function routeKey(sql: string): string {
  if (sql.includes('/* pat_apply:loss_insert */')) return 'loss_insert';
  if (sql.includes('/* pat_apply:loss_reread */')) return 'loss_reread';
  if (sql.includes('/* pat_apply:loss_update */')) return 'loss_update';
  if (sql.includes('/* pat_apply:opp_pair */')) return 'opp_pair';
  if (sql.includes('/* pat_apply:backfill_state */')) return 'backfill_state';
  return 'other';
}

type Handler = (params: any[]) => { rows: any[]; rowCount?: number };

/** Fake pool + client (mesma tabela de rotas). withConversationLock injetado usa o client. */
function makeFakePool(routes: Partial<Record<string, Handler>>) {
  const calls: { key: string; params: any[] }[] = [];
  const run = (sql: string, params: any[] = []) => {
    const key = routeKey(sql);
    calls.push({ key, params });
    const h = routes[key];
    const res = h ? h(params) : { rows: [], rowCount: 0 };
    return Promise.resolve({ rows: res.rows, rowCount: res.rowCount ?? res.rows.length });
  };
  const client = { query: run, release() {} };
  const pool = { query: run, connect: () => Promise.resolve(client) } as unknown as Pool;
  return { pool, calls, client };
}

function baseCtx(over: Partial<PatternContext> = {}): PatternContext {
  return {
    workspaceId: 'ws',
    periodStart: '2026-07-13',
    periodEnd: '2026-07-19',
    judgments: [],
    tags: [],
    lossReasons: [],
    aggregates: { byOpportunityTag: {}, byLossReason: {}, byOpportunityStatus: {} },
    guidances: { lead: null, qualified: null },
    triageCounts: { judged: 0, toLead: 0, toNotLead: 0 },
    opportunityIds: [],
    lossBackfillCandidates: [],
    ...over,
  };
}

function baseDecision(over: Partial<PatternDecision> = {}): PatternDecision {
  return {
    tagSuggestions: [], newLossReasons: [], editLossReasons: [],
    guidanceSuggestions: [], backfillLossReasons: [], insightSummary: 'resumo da semana', ...over,
  };
}

/** deps com spies pro lock/sticky/store; captura chamadas. */
function makeDeps(over: {
  runId?: number | null;
  stickyByOpp?: Record<number, StickyFlags>;
  suggestionResult?: (kind: string) => number | null;
  insightId?: number | null;
  validLoss?: boolean;
  patchResult?: { oppChanged: boolean; threadChanged: boolean };
} = {}) {
  const log = {
    suggestions: [] as { ws: string; kind: string; payload: any }[],
    insights: [] as { ws: string; runId: number | null; summary: string; details: any }[],
    events: [] as any[],
    stickyCalls: [] as any[],
    patches: [] as { oppId: number; cur: any; patch: any; changedBy: string; pair: any }[],
  };
  const deps: ApplyPatternDeps = {
    runId: over.runId === undefined ? 7 : over.runId,
    computeSticky: (async (_client: any, p: any) => {
      log.stickyCalls.push(p);
      return over.stickyByOpp?.[p.opportunityId] ?? NO_STICKY;
    }) as any,
    withConversationLock: (async (_pool: any, _numberId: any, _identifier: any, fn: any) => {
      const client = { query: (_pool as any).__lockClientQuery };
      return fn(client);
    }) as any,
    applyOppPatchInTx: (async (_client: any, oppId: number, cur: any, patch: any, changedBy: string, pair: any) => {
      log.patches.push({ oppId, cur, patch, changedBy, pair });
      return over.patchResult ?? { oppChanged: true, threadChanged: false };
    }) as any,
    isValidLossReason: (async () => over.validLoss ?? true) as any,
    insertSuggestion: (async (_pool: any, ws: string, kind: string, payload: any) => {
      log.suggestions.push({ ws, kind, payload });
      return over.suggestionResult ? over.suggestionResult(kind) : 100;
    }) as any,
    insertInsight: (async (_pool: any, ws: string, runId: number | null, summary: string, details: any) => {
      log.insights.push({ ws, runId, summary, details });
      return over.insightId === undefined ? 999 : over.insightId;
    }) as any,
  };
  return { deps, log };
}

// helper: injeta o query do client do lock no pool fake (o withConversationLock fake o usa)
function wireLockClient(pool: Pool, client: { query: any }) {
  (pool as any).__lockClientQuery = client.query;
}

// =============================================================================
// motivos de perda
// =============================================================================

test('motivo novo: code = slug do label, created_by=ai → loss_created', async () => {
  const { pool, calls } = makeFakePool({ loss_insert: () => ({ rows: [{ id: 7 }] }) });
  const { deps } = makeDeps();
  const res = await applyPatternDecision(pool, baseCtx(), baseDecision({
    newLossReasons: [{ label: 'Sem orçamento', description: 'achou caro' }],
  }), deps);
  assert.ok(res.applied.includes('loss_created:7'));
  const ins = calls.find((c) => c.key === 'loss_insert')!;
  assert.equal(ins.params[1], 'sem_orcamento', 'code slugificado');
  assert.equal(ins.params[2], 'Sem orçamento');
});

test('editLossReason: guard 0 rows → skip human_owned', async () => {
  const { pool } = makeFakePool({ loss_update: () => ({ rows: [], rowCount: 0 }) });
  const { deps } = makeDeps();
  const res = await applyPatternDecision(pool, baseCtx(), baseDecision({
    editLossReasons: [{ id: 9, description: 'melhor' }],
  }), deps);
  assert.ok(res.skipped.includes('loss_edit:9:human_owned'));
});

// =============================================================================
// suggestions / insight / backfill note
// =============================================================================

test('guidance → insertSuggestion {current, suggested, reason}; dedupe → skip', async () => {
  const { pool } = makeFakePool({});
  const { deps, log } = makeDeps({
    suggestionResult: (kind) => (kind === 'guidance_lead' ? 5 : null), // qualified já pendente → dedupe
  });
  const res = await applyPatternDecision(pool, baseCtx({ guidances: { lead: 'texto atual lead', qualified: 'atual qual' } }), baseDecision({
    guidanceSuggestions: [
      { kind: 'guidance_lead', suggested: 'novo lead', reason: 'r1' },
      { kind: 'guidance_qualified', suggested: 'novo qual', reason: 'r2' },
    ],
  }), deps);
  assert.ok(res.applied.includes('suggestion:guidance_lead'));
  assert.ok(res.skipped.includes('suggestion:guidance_qualified:dedupe'));
  assert.deepEqual(log.suggestions[0].payload, { current: 'texto atual lead', suggested: 'novo lead', reason: 'r1' });
  assert.deepEqual(log.suggestions[1].payload, { current: 'atual qual', suggested: 'novo qual', reason: 'r2' });
});

test('insight: insertInsight com runId + summary; applied inclui insight:id', async () => {
  const { pool } = makeFakePool({});
  const { deps, log } = makeDeps({ runId: 42, insightId: 888 });
  const res = await applyPatternDecision(pool, baseCtx(), baseDecision({ insightSummary: 'semana forte' }), deps);
  assert.ok(res.applied.includes('insight:888'));
  assert.equal(log.insights.length, 1);
  assert.equal(log.insights[0].runId, 42);
  assert.equal(log.insights[0].summary, 'semana forte');
});

test('insight: insertInsight null (retomada, insight da run já existe) → skip insight:dedupe', async () => {
  const { pool } = makeFakePool({});
  const { deps } = makeDeps({ insightId: null }); // ON CONFLICT DO NOTHING devolveu null
  const res = await applyPatternDecision(pool, baseCtx(), baseDecision({ insightSummary: 's' }), deps);
  assert.ok(res.skipped.includes('insight:dedupe'));
  assert.ok(!res.applied.some((a) => a.startsWith('insight:')), 'nenhum insight:id aplicado');
});

// =============================================================================
// backfill de loss_reason (spec §8) — patch via kernel sob o lock do par
// =============================================================================

test('backfill: opp perdido + loss_reason NULL + sem sticky → applyOppPatchInTx {lossReason} changedBy=ai', async () => {
  const { pool, client } = makeFakePool({
    opp_pair: () => ({ rows: [{ whatsapp_number_id: 1, identifier: 'c', workspace_id: 'ws' }] }),
    backfill_state: () => ({ rows: [{ status: 'perdido', is_qualified: null, closed_at: new Date('2026-07-15T00:00:00Z'), title: null, loss_reason: null }] }),
  });
  wireLockClient(pool, client);
  const { deps, log } = makeDeps();
  const res = await applyPatternDecision(pool, baseCtx(), baseDecision({
    backfillLossReasons: [{ opportunityId: 71, code: 'preco' }],
  }), deps);
  assert.ok(res.applied.includes('backfill_loss:71:preco'));
  assert.equal(log.patches.length, 1);
  assert.deepEqual(log.patches[0].patch, { lossReason: 'preco' });
  assert.equal(log.patches[0].changedBy, 'ai');
  assert.equal(log.patches[0].cur.status, 'perdido');
  assert.equal(log.patches[0].cur.lossReason, null);
});

test('backfill: sticky com evento humano de loss_reason → skip human_owned, sem patch', async () => {
  const { pool, client } = makeFakePool({
    opp_pair: () => ({ rows: [{ whatsapp_number_id: 1, identifier: 'c', workspace_id: 'ws' }] }),
    backfill_state: () => ({ rows: [{ status: 'perdido', is_qualified: null, closed_at: null, title: null, loss_reason: null }] }),
  });
  wireLockClient(pool, client);
  const { deps, log } = makeDeps({ stickyByOpp: { 71: { ...NO_STICKY, lossReason: true } } });
  const res = await applyPatternDecision(pool, baseCtx(), baseDecision({
    backfillLossReasons: [{ opportunityId: 71, code: 'preco' }],
  }), deps);
  assert.ok(res.skipped.includes('backfill_loss:71:human_owned'));
  assert.equal(log.patches.length, 0, 'não aplica patch quando humano já mexeu no motivo');
});

test('backfill: opp NÃO-perdida no re-read (reaberta) → skip not_perdido', async () => {
  const { pool, client } = makeFakePool({
    opp_pair: () => ({ rows: [{ whatsapp_number_id: 1, identifier: 'c', workspace_id: 'ws' }] }),
    backfill_state: () => ({ rows: [{ status: 'em_andamento', is_qualified: null, closed_at: null, title: null, loss_reason: null }] }),
  });
  wireLockClient(pool, client);
  const { deps, log } = makeDeps();
  const res = await applyPatternDecision(pool, baseCtx(), baseDecision({
    backfillLossReasons: [{ opportunityId: 71, code: 'preco' }],
  }), deps);
  assert.ok(res.skipped.includes('backfill_loss:71:not_perdido'));
  assert.equal(log.patches.length, 0);
});

test('backfill: loss_reason já preenchido no re-read → skip already_set', async () => {
  const { pool, client } = makeFakePool({
    opp_pair: () => ({ rows: [{ whatsapp_number_id: 1, identifier: 'c', workspace_id: 'ws' }] }),
    backfill_state: () => ({ rows: [{ status: 'perdido', is_qualified: null, closed_at: null, title: null, loss_reason: 'ja_tem' }] }),
  });
  wireLockClient(pool, client);
  const { deps, log } = makeDeps();
  const res = await applyPatternDecision(pool, baseCtx(), baseDecision({
    backfillLossReasons: [{ opportunityId: 71, code: 'preco' }],
  }), deps);
  assert.ok(res.skipped.includes('backfill_loss:71:already_set'));
  assert.equal(log.patches.length, 0);
});

test('backfill: código desativado sob o lock (isValidLossReason false) → skip invalid_code', async () => {
  const { pool, client } = makeFakePool({
    opp_pair: () => ({ rows: [{ whatsapp_number_id: 1, identifier: 'c', workspace_id: 'ws' }] }),
    backfill_state: () => ({ rows: [{ status: 'perdido', is_qualified: null, closed_at: null, title: null, loss_reason: null }] }),
  });
  wireLockClient(pool, client);
  const { deps, log } = makeDeps({ validLoss: false });
  const res = await applyPatternDecision(pool, baseCtx(), baseDecision({
    backfillLossReasons: [{ opportunityId: 71, code: 'preco' }],
  }), deps);
  assert.ok(res.skipped.includes('backfill_loss:71:invalid_code'));
  assert.equal(log.patches.length, 0);
});

test('backfill: opp de outro workspace → skip not_found sem abrir estado', async () => {
  const { pool, client } = makeFakePool({
    opp_pair: () => ({ rows: [{ whatsapp_number_id: 1, identifier: 'c', workspace_id: 'OUTRO' }] }),
  });
  wireLockClient(pool, client);
  const { deps, log } = makeDeps();
  const res = await applyPatternDecision(pool, baseCtx(), baseDecision({
    backfillLossReasons: [{ opportunityId: 71, code: 'preco' }],
  }), deps);
  assert.ok(res.skipped.includes('backfill_loss:71:not_found'));
  assert.equal(log.patches.length, 0);
});

// =============================================================================
// sugestão de tag — o worker não escreve mais no catálogo de tags
// =============================================================================

test('aplicador insere sugestão tag_new e não escreve em whatsapp_tags', async () => {
  const { pool } = makeFakePool({});
  const queries: string[] = [];
  const spy = { ...pool, query: (sql: string, p?: any[]) => { queries.push(sql); return (pool as any).query(sql, p); } } as unknown as Pool;
  const { deps, log } = makeDeps({ suggestionResult: (kind) => (kind === 'tag_new' ? 77 : 100) });
  const res = await applyPatternDecision(spy, baseCtx(), baseDecision({
    tagSuggestions: [
      { name: 'Telhado', description: 'obra no telhado', reason: 'recorrente' },
      { name: 'Piso', description: null, reason: 'r' },
    ],
  }), deps);
  const tagNew = log.suggestions.filter((x) => x.kind === 'tag_new');
  assert.deepEqual(tagNew.map((x) => x.payload), [
    { name: 'Telhado', description: 'obra no telhado', reason: 'recorrente' },
    { name: 'Piso', description: null, reason: 'r' },
  ]);
  assert.ok(res.applied.includes('suggestion:tag_new:Telhado'));
  assert.equal(queries.some((q) => /whatsapp_tags/.test(q)), false);
});

test('sugestão tag_new repetida (dedupe por nome) vira skip', async () => {
  const { pool } = makeFakePool({});
  const { deps } = makeDeps({ suggestionResult: () => null });
  const res = await applyPatternDecision(pool, baseCtx(), baseDecision({
    tagSuggestions: [{ name: 'Telhado', description: null, reason: 'r' }],
  }), deps);
  assert.ok(res.skipped.includes('suggestion:tag_new:Telhado:dedupe'));
});
