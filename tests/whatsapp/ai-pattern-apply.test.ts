// tests/whatsapp/ai-pattern-apply.test.ts  (PURO — fake pool routeado por marcador + deps injetados)
//
// Prova a ORQUESTRAÇÃO do aplicador do motor de IA nível 2 (Task E3, spec v3 §8):
//   - tags novas: cor do ciclo TAG_COLORS (índice = count existentes % len), created_by='ai';
//   - tags editadas: guard humano IN-SQL (NOT humanActorSql) → 0 rows = skip human_owned;
//   - colisão de aplicação (race) → re-lê e trata como edit se não-humana, senão skip;
//   - motivos de perda novos (code = slug do label) e editados (guard);
//   - retro-etiquetagem sob o lock do par, add-only, respeita tagsRemovedByHuman DAQUELA opp;
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
  if (sql.includes('/* pat_apply:tag_count */')) return 'tag_count';
  if (sql.includes('/* pat_apply:tag_insert */')) return 'tag_insert';
  if (sql.includes('/* pat_apply:tag_reread */')) return 'tag_reread';
  if (sql.includes('/* pat_apply:tag_update */')) return 'tag_update';
  if (sql.includes('/* pat_apply:loss_insert */')) return 'loss_insert';
  if (sql.includes('/* pat_apply:loss_reread */')) return 'loss_reread';
  if (sql.includes('/* pat_apply:loss_update */')) return 'loss_update';
  if (sql.includes('/* pat_apply:opp_pair */')) return 'opp_pair';
  if (sql.includes('/* pat_apply:retro_tag_insert */')) return 'retro_tag_insert';
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
    newTags: [], editTags: [], newLossReasons: [], editLossReasons: [],
    guidanceSuggestions: [], backfillLossReasons: [], insightSummary: 'resumo da semana', ...over,
  };
}

/** deps com spies pro lock/sticky/store/insertEvent; captura chamadas. */
function makeDeps(over: {
  runId?: number | null;
  stickyByOpp?: Record<number, StickyFlags>;
  suggestionResult?: (kind: string) => number | null;
  insightId?: number;
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
    insertEvent: (async (_client: any, p: any) => { log.events.push(p); }) as any,
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
      return over.insightId ?? 999;
    }) as any,
  };
  return { deps, log };
}

// helper: injeta o query do client do lock no pool fake (o withConversationLock fake o usa)
function wireLockClient(pool: Pool, client: { query: any }) {
  (pool as any).__lockClientQuery = client.query;
}

// =============================================================================
// tags novas — cor do ciclo + created_by='ai'
// =============================================================================

test('tag nova: cor do ciclo TAG_COLORS (índice = count existentes % len), created_by=ai', async () => {
  const { pool, calls } = makeFakePool({
    tag_count: () => ({ rows: [{ n: 2 }] }),          // 2 existentes → slot 2
    tag_insert: () => ({ rows: [{ id: 50 }] }),
  });
  const { deps } = makeDeps();
  const res = await applyPatternDecision(pool, baseCtx(), baseDecision({
    newTags: [{ name: 'Plano de saúde', description: 'aceita convênio', retroOpportunityIds: [] }],
  }), deps);
  assert.ok(res.applied.includes('tag_created:50'));
  const ins = calls.find((c) => c.key === 'tag_insert')!;
  assert.equal(ins.params[1], 'Plano de saúde');
  assert.equal(ins.params[2], TAG_COLORS[2 % TAG_COLORS.length], 'cor = slot 2 do ciclo');
  assert.equal(ins.params[3], 'aceita convênio');
});

test('2 tags novas: a cor avança só em INSERT real (colisão não consome slot)', async () => {
  let n = 0;
  const { pool, calls } = makeFakePool({
    tag_count: () => ({ rows: [{ n: 0 }] }),
    tag_insert: () => { n += 1; return n === 1 ? { rows: [], rowCount: 0 } : { rows: [{ id: 60 }] }; }, // 1ª colide, 2ª insere
    tag_reread: () => ({ rows: [{ id: 41, updated_by: 'ai' }] }),
    tag_update: () => ({ rows: [{ id: 41 }], rowCount: 1 }),
  });
  const { deps } = makeDeps();
  await applyPatternDecision(pool, baseCtx(), baseDecision({
    newTags: [
      { name: 'A', description: 'da', retroOpportunityIds: [] },
      { name: 'B', description: 'db', retroOpportunityIds: [] },
    ],
  }), deps);
  const inserts = calls.filter((c) => c.key === 'tag_insert');
  // a 2ª tag (que de fato insere) usa o slot 0 (a colisão não avançou o contador).
  assert.equal(inserts[1].params[2], TAG_COLORS[0]);
});

// =============================================================================
// tags editadas — guard humano IN-SQL
// =============================================================================

test('editTag: guard 0 rows (humano correu na frente) → skip human_owned', async () => {
  const { pool } = makeFakePool({ tag_update: () => ({ rows: [], rowCount: 0 }) });
  const { deps } = makeDeps();
  const res = await applyPatternDecision(pool, baseCtx(), baseDecision({
    editTags: [{ id: 12, description: 'nova' }],
  }), deps);
  assert.ok(res.skipped.includes('tag_edit:12:human_owned'));
  assert.ok(!res.applied.some((a) => a.startsWith('tag_edited')));
});

test('editTag: UPDATE afeta 1 row → tag_edited', async () => {
  const { pool, calls } = makeFakePool({ tag_update: () => ({ rows: [{ id: 12 }], rowCount: 1 }) });
  const { deps } = makeDeps();
  const res = await applyPatternDecision(pool, baseCtx(), baseDecision({
    editTags: [{ id: 12, description: 'nova' }],
  }), deps);
  assert.ok(res.applied.includes('tag_edited:12'));
  const upd = calls.find((c) => c.key === 'tag_update')!;
  assert.deepEqual(upd.params, [12, 'ws', 'nova']);
});

test('tag nova colide na aplicação com tag HUMANA → não edita a description (skip human_owned)', async () => {
  const { pool } = makeFakePool({
    tag_count: () => ({ rows: [{ n: 0 }] }),
    tag_insert: () => ({ rows: [], rowCount: 0 }),               // conflito
    tag_reread: () => ({ rows: [{ id: 30, updated_by: 'uuid-humano' }] }),
    tag_update: () => ({ rows: [], rowCount: 0 }),               // guard barra o humano
  });
  const { deps } = makeDeps();
  const res = await applyPatternDecision(pool, baseCtx(), baseDecision({
    newTags: [{ name: 'Bairro X', description: 'tenta reescrever', retroOpportunityIds: [] }],
  }), deps);
  assert.ok(res.skipped.includes('tag_conflict:Bairro X:human_owned'));
});

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
// retro-etiquetagem — lock por par, add-only, respeita sticky
// =============================================================================

test('retro-etiquetagem: sob lock do par, respeita tagsRemovedByHuman DAQUELA opp', async () => {
  // opp 41: humano removeu 'Plano' → skip; opp 55: sem remoção → insere + evento.
  const { pool, client, calls } = makeFakePool({
    tag_count: () => ({ rows: [{ n: 0 }] }),
    tag_insert: () => ({ rows: [{ id: 50 }] }),
    opp_pair: (p) => ({ rows: [{ whatsapp_number_id: 1, identifier: `c${p[0]}`, workspace_id: 'ws' }] }),
    retro_tag_insert: () => ({ rows: [{ tag_id: 50 }], rowCount: 1 }),
  });
  wireLockClient(pool, client);
  const { deps, log } = makeDeps({
    stickyByOpp: { 41: { ...NO_STICKY, tagsRemovedByHuman: ['Plano'] }, 55: NO_STICKY },
  });
  const res = await applyPatternDecision(pool, baseCtx({ opportunityIds: [41, 55] }), baseDecision({
    newTags: [{ name: 'Plano', description: 'd', retroOpportunityIds: [41, 55] }],
  }), deps);
  assert.ok(res.skipped.includes('retro_tag:41:50:removed_by_human'), 'opp com remoção humana pulada');
  assert.ok(res.applied.includes('retro_tag:55:50'), 'opp sem remoção etiquetada');
  assert.equal(log.events.length, 1, 'um evento tag_added (só a 55)');
  assert.equal(log.events[0].field, 'tag_added');
  assert.equal(log.events[0].changedBy, 'ai');
  assert.equal(log.events[0].opportunityId, 55);
  // opp_pair lido pros 2; retro insert só pra 55.
  assert.equal(calls.filter((c) => c.key === 'opp_pair').length, 2);
  assert.equal(calls.filter((c) => c.key === 'retro_tag_insert').length, 1);
});

test('retro-etiquetagem: opp de outro workspace / inexistente → skip not_found (sem lock útil)', async () => {
  const { pool, client } = makeFakePool({
    tag_count: () => ({ rows: [{ n: 0 }] }),
    tag_insert: () => ({ rows: [{ id: 50 }] }),
    opp_pair: () => ({ rows: [{ whatsapp_number_id: 1, identifier: 'x', workspace_id: 'OUTRO' }] }),
  });
  wireLockClient(pool, client);
  const { deps, log } = makeDeps();
  const res = await applyPatternDecision(pool, baseCtx({ opportunityIds: [41] }), baseDecision({
    newTags: [{ name: 'Plano', description: 'd', retroOpportunityIds: [41] }],
  }), deps);
  assert.ok(res.skipped.includes('retro_tag:41:50:not_found'));
  assert.equal(log.events.length, 0);
});

test('retro-etiquetagem: MESMA opp em 2 tags trava o par UMA vez (agrupado por opp)', async () => {
  const { pool, client, calls } = makeFakePool({
    tag_count: () => ({ rows: [{ n: 0 }] }),
    tag_insert: (p) => ({ rows: [{ id: p[1] === 'A' ? 50 : 51 }] }),
    opp_pair: () => ({ rows: [{ whatsapp_number_id: 1, identifier: 'c', workspace_id: 'ws' }] }),
    retro_tag_insert: () => ({ rows: [{ tag_id: 1 }], rowCount: 1 }),
  });
  wireLockClient(pool, client);
  const { deps, log } = makeDeps();
  const res = await applyPatternDecision(pool, baseCtx({ opportunityIds: [41] }), baseDecision({
    newTags: [
      { name: 'A', description: 'da', retroOpportunityIds: [41] },
      { name: 'B', description: 'db', retroOpportunityIds: [41] },
    ],
  }), deps);
  assert.equal(calls.filter((c) => c.key === 'opp_pair').length, 1, 'par lido uma vez só');
  assert.equal(log.stickyCalls.length, 1, 'sticky computado uma vez só');
  assert.ok(res.applied.includes('retro_tag:41:50'));
  assert.ok(res.applied.includes('retro_tag:41:51'));
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
