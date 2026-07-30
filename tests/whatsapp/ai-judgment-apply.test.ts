// tests/whatsapp/ai-judgment-apply.test.ts  (PURO — fake pool/client + deps injetados)
//
// Prova a ORQUESTRAÇÃO do aplicador do julgamento IA (Task D4, spec v3 §7):
//   - ordem obrigatória lock → stale-checks → CLAIM → aplicações;
//   - lastMessageAt null → skip sem lock/claim;
//   - stale (watermark novo OU opp aberta surgida/mutada) → nada escrito;
//   - claim-conflito (UNIQUE) → retorna cedo, NENHUMA aplicação;
//   - triagem não-lead com opp ganha (LeadCascadeGanhoError) pula SÓ a triagem;
//   - tags add-only respeitam sticky.tagsRemovedByHuman.
// A correção do SQL real (kernel, cascata, upsert) é coberta pelo .db.test + suites do
// data layer; aqui os colaboradores pesados são spies injetados via `deps`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { applyJudgment, type ApplyJudgmentDeps } from '../../src/whatsapp/ai-judgment-apply.js';
import type { JudgmentContext, OppSnapshot } from '../../src/whatsapp/ai-judgment-context.js';
import type { JudgmentDecision } from '../../src/whatsapp/ai-judgment-prompt.js';
import type { StickyFlags } from '../../src/whatsapp/ai-sticky.js';
import { LeadCascadeGanhoError } from '../../src/whatsapp/thread-meta.js';

// ── roteamento por marcador de SQL ──────────────────────────────────────────────
function routeKey(sql: string): string {
  if (sql.includes('/* apply:watermark */')) return 'watermark';
  if (sql.includes('/* apply:open_opp */')) return 'open_opp';
  if (sql.includes('/* apply:last_closed */')) return 'last_closed';
  if (sql.includes('/* apply:claim */')) return 'claim';
  if (sql.includes('/* apply:tag_target */')) return 'tag_target';
  if (sql.includes('/* apply:tag_name */')) return 'tag_name';
  if (sql.includes('/* apply:tag_insert */')) return 'tag_insert';
  if (sql.includes('/* apply:applied_update */')) return 'applied_update';
  if (/^\s*BEGIN/i.test(sql)) return 'begin';
  if (sql.includes('pg_advisory_xact_lock')) return 'lock';
  if (/^\s*COMMIT/i.test(sql)) return 'commit';
  if (/^\s*ROLLBACK/i.test(sql)) return 'rollback';
  return 'other';
}

type Handler = (params: any[]) => { rows: any[]; rowCount?: number };

function makeFakePool(routes: Partial<Record<string, Handler>>, order: string[]) {
  const calls: { key: string; params: any[] }[] = [];
  const client = {
    query(sql: string, params: any[] = []) {
      const key = routeKey(sql);
      calls.push({ key, params });
      order.push(key);
      const h = routes[key];
      const res = h ? h(params) : { rows: [], rowCount: 0 };
      return Promise.resolve({ rows: res.rows, rowCount: res.rowCount ?? res.rows.length });
    },
    release() {},
  };
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
  return { pool, calls };
}

const NO_STICKY: StickyFlags = { isLead: false, isQualified: false, status: false, lossReason: false, tagsRemovedByHuman: [] };

function baseCtx(over: Partial<JudgmentContext> = {}): JudgmentContext {
  return {
    numberId: 1, identifier: 'c', workspaceId: 'ws',
    watermark: null, lastMessageAt: '2026-07-30T10:00:00.000Z',
    messages: [], triage: { isLead: null, leadSource: null, notes: null },
    openOpp: null, lastClosedOpp: null,
    settings: { newOppAfterDays: 30, aiLeadGuidance: null, aiQualifiedGuidance: null },
    lossReasons: [], notLeadReasons: [], tags: [],
    sticky: NO_STICKY,
    ...over,
  };
}

function baseDecision(over: Partial<JudgmentDecision> = {}): JudgmentDecision {
  return { triage: null, notLeadReason: null, openOpp: null, closedAction: null, tags: [], rationale: 'r', ...over };
}

function openSnapshot(over: Partial<OppSnapshot> = {}): OppSnapshot {
  return {
    id: 5, title: null, status: 'em_andamento', isQualified: null, lossReason: null, tags: [],
    createdAt: '2026-07-30T08:00:00.000Z', updatedAt: '2026-07-30T09:00:00.000Z', closedAt: null,
    ...over,
  };
}

/** Row do banco (SELECT apply:open_opp) que CASA com openSnapshot (não-stale). */
function openOppRow(over: Record<string, unknown> = {}) {
  return {
    id: 5, updated_at: new Date('2026-07-30T09:00:00.000Z'),
    status: 'em_andamento', is_qualified: null, closed_at: null, title: null, loss_reason: null,
    ...over,
  };
}

/** Spies dos colaboradores pesados; empurram o próprio nome no `order`. */
function makeDeps(order: string[], over: {
  sticky?: StickyFlags;
  leadUpdate?: (params: any) => void;
  patchResult?: { oppChanged: boolean; threadChanged: boolean };
  openCount?: number;
  validLoss?: boolean;
  newOppId?: number;
} = {}) {
  const log = {
    leadUpdate: [] as any[],
    patch: [] as any[],
    insertOpp: [] as any[],
    insertEvent: [] as any[],
    sticky: [] as any[],
  };
  const deps: ApplyJudgmentDeps = {
    model: 'test-model',
    computeSticky: (async (_c: any, p: any) => { order.push('computeSticky'); log.sticky.push(p); return over.sticky ?? NO_STICKY; }) as any,
    applyLeadUpdate: (async (_c: any, p: any) => {
      order.push('applyLeadUpdate'); log.leadUpdate.push(p);
      if (over.leadUpdate) over.leadUpdate(p);
    }) as any,
    applyOppPatchInTx: (async (_c: any, oppId: any, cur: any, patch: any, changedBy: any, pair: any) => {
      order.push('applyOppPatchInTx'); log.patch.push({ oppId, patch, changedBy, pair });
      return over.patchResult ?? { oppChanged: true, threadChanged: false };
    }) as any,
    insertOpportunityInTx: (async (_c: any, p: any) => { order.push('insertOpportunityInTx'); log.insertOpp.push(p); return over.newOppId ?? 77; }) as any,
    insertEvent: (async (_c: any, p: any) => { order.push('insertEvent'); log.insertEvent.push(p); }) as any,
    countOpenOpportunities: (async () => over.openCount ?? 0) as any,
    isValidLossReason: (async () => over.validLoss ?? true) as any,
  };
  return { deps, log };
}

// =============================================================================
test('lastMessageAt null → skip sem lock nem claim', async () => {
  const order: string[] = [];
  const { pool, calls } = makeFakePool({}, order);
  const { deps } = makeDeps(order);
  const res = await applyJudgment(pool, baseCtx({ lastMessageAt: null }), baseDecision(), deps);
  assert.deepEqual(res, { applied: [], skipped: ['no_last_message'], stale: false });
  assert.equal(calls.length, 0, 'não deve nem conectar (zero queries)');
});

test('stale por watermark (mensagem nova) → nada escrito, sem claim', async () => {
  const order: string[] = [];
  const { pool, calls } = makeFakePool({
    watermark: () => ({ rows: [{ m: new Date('2026-07-30T10:05:00.000Z') }] }),
  }, order);
  const { deps, log } = makeDeps(order);
  const res = await applyJudgment(pool, baseCtx(), baseDecision({ triage: 'lead' }), deps);
  assert.deepEqual(res, { applied: [], skipped: [], stale: true });
  assert.ok(!calls.some((c) => c.key === 'claim'), 'claim NÃO deve rodar');
  assert.equal(log.leadUpdate.length, 0, 'nenhuma triagem aplicada');
});

test('stale por opp aberta que surgiu desde o snapshot → stale, sem claim', async () => {
  const order: string[] = [];
  const { pool, calls } = makeFakePool({
    watermark: () => ({ rows: [{ m: new Date('2026-07-30T10:00:00.000Z') }] }),
    open_opp: () => ({ rows: [openOppRow()] }), // ctx.openOpp é null, mas agora existe uma aberta
  }, order);
  const { deps } = makeDeps(order);
  const res = await applyJudgment(pool, baseCtx({ openOpp: null }), baseDecision({ triage: 'lead' }), deps);
  assert.deepEqual(res, { applied: [], skipped: [], stale: true });
  assert.ok(!calls.some((c) => c.key === 'claim'));
});

test('claim conflito (já julgado) → already_judged, nenhuma aplicação', async () => {
  const order: string[] = [];
  const { pool } = makeFakePool({
    watermark: () => ({ rows: [{ m: new Date('2026-07-30T10:00:00.000Z') }] }),
    open_opp: () => ({ rows: [] }),
    claim: () => ({ rows: [], rowCount: 0 }), // ON CONFLICT DO NOTHING não retornou id
  }, order);
  const { deps, log } = makeDeps(order);
  const res = await applyJudgment(pool, baseCtx(), baseDecision({ triage: 'lead', tags: [1] }), deps);
  assert.deepEqual(res, { applied: [], skipped: ['already_judged'], stale: false });
  assert.equal(log.sticky.length, 0, 'nem recomputa sticky');
  assert.equal(log.leadUpdate.length, 0, 'nenhuma triagem');
  assert.ok(!order.includes('applied_update'), 'não sobrescreve applied (não aplicou nada)');
});

test('ordem: lock → watermark → open_opp → claim → sticky → aplicações → commit', async () => {
  const order: string[] = [];
  const { pool } = makeFakePool({
    watermark: () => ({ rows: [{ m: new Date('2026-07-30T10:00:00.000Z') }] }),
    open_opp: () => ({ rows: [] }),
    claim: () => ({ rows: [{ id: 99 }] }),
    last_closed: () => ({ rows: [] }),
  }, order);
  const { deps } = makeDeps(order);
  const res = await applyJudgment(pool, baseCtx(), baseDecision({ triage: 'lead' }), deps);
  assert.deepEqual(res, { applied: ['triage:lead'], skipped: [], stale: false });
  assert.deepEqual(order, [
    'begin', 'lock', 'watermark', 'open_opp', 'claim', 'last_closed',
    'computeSticky', 'applyLeadUpdate', 'applied_update', 'commit',
  ]);
});

test('triagem não-lead com opp ganha (LeadCascadeGanhoError) pula SÓ a triagem; patch da opp segue', async () => {
  const order: string[] = [];
  const { pool } = makeFakePool({
    watermark: () => ({ rows: [{ m: new Date('2026-07-30T10:00:00.000Z') }] }),
    open_opp: () => ({ rows: [openOppRow()] }), // opp aberta existe (casa o snapshot)
    claim: () => ({ rows: [{ id: 99 }] }),
    last_closed: () => ({ rows: [] }),
  }, order);
  const { deps, log } = makeDeps(order, {
    leadUpdate: (p) => { if (p.isLead === false) throw new LeadCascadeGanhoError('c'); },
  });
  const decision = baseDecision({
    triage: 'not_lead', notLeadReason: 'spam',
    openOpp: { qualify: true, status: null, lossReason: null },
  });
  const res = await applyJudgment(pool, baseCtx({ openOpp: openSnapshot() }), decision, deps);
  assert.ok(res.skipped.includes('triage:possui_ganho'), 'triagem pulada por opp ganha');
  assert.ok(res.applied.includes('qualify:true'), 'patch da opp aberta ainda aplicado');
  assert.equal(log.patch.length, 1, 'applyOppPatchInTx chamado uma vez');
  assert.deepEqual(log.patch[0].patch, { isQualified: true });
  assert.equal(log.patch[0].changedBy, 'ai');
});

test('tags add-only respeitam removedByHuman; só as não-removidas entram', async () => {
  const order: string[] = [];
  const insertedTags: number[] = [];
  const { pool } = makeFakePool({
    watermark: () => ({ rows: [{ m: new Date('2026-07-30T10:00:00.000Z') }] }),
    open_opp: () => ({ rows: [openOppRow()] }),
    claim: () => ({ rows: [{ id: 99 }] }),
    last_closed: () => ({ rows: [] }),
    tag_target: () => ({ rows: [{ id: 5 }] }), // alvo = a opp aberta (== stickyOppId)
    tag_name: (p) => ({ rows: [{ name: p[0] === 10 ? 'VIP' : 'novo' }] }),
    tag_insert: (p) => { insertedTags.push(p[1]); return { rows: [{ tag_id: p[1] }], rowCount: 1 }; },
  }, order);
  const { deps, log } = makeDeps(order, {
    sticky: { ...NO_STICKY, tagsRemovedByHuman: ['VIP'] },
  });
  const res = await applyJudgment(pool, baseCtx({ openOpp: openSnapshot() }), baseDecision({ tags: [10, 11] }), deps);
  assert.ok(res.skipped.includes('tag:10:removed_by_human'), 'tag removida por humano não re-entra');
  assert.ok(res.applied.includes('tag:11'), 'tag nova entra');
  assert.deepEqual(insertedTags, [11], 'só a tag 11 foi inserida');
  assert.equal(log.insertEvent.length, 1, 'um evento tag_added');
  assert.equal(log.insertEvent[0].field, 'tag_added');
  assert.equal(log.insertEvent[0].changedBy, 'ai');
});

test('closed_action=criar_nova sem opp aberta → cria opp ai + tags vão pra ela (sem trava herdada)', async () => {
  const order: string[] = [];
  const insertedTags: { opp: number; tag: number }[] = [];
  const { pool } = makeFakePool({
    watermark: () => ({ rows: [{ m: new Date('2026-07-30T10:00:00.000Z') }] }),
    open_opp: () => ({ rows: [] }),
    claim: () => ({ rows: [{ id: 99 }] }),
    last_closed: () => ({ rows: [{ id: 3, updated_at: new Date('2026-07-29T00:00:00Z'), status: 'perdido', is_qualified: null, closed_at: new Date('2026-07-29T00:00:00Z'), title: null, loss_reason: 'x' }] }),
    tag_name: () => ({ rows: [{ name: 'VIP' }] }),
    tag_insert: (p) => { insertedTags.push({ opp: p[0], tag: p[1] }); return { rows: [{ tag_id: p[1] }], rowCount: 1 }; },
  }, order);
  // sticky diz que 'VIP' foi removida da opp FECHADA (id 3); a nova opp (77) não herda a trava.
  const { deps } = makeDeps(order, {
    sticky: { ...NO_STICKY, tagsRemovedByHuman: ['VIP'] },
    newOppId: 77,
  });
  const res = await applyJudgment(pool, baseCtx({ lastClosedOpp: openSnapshot({ id: 3, status: 'perdido', lossReason: 'x' }) }), baseDecision({ closedAction: 'criar_nova', tags: [10] }), deps);
  assert.ok(res.applied.includes('criar_nova'));
  assert.ok(res.applied.includes('tag:10'), 'tag entra na opp NOVA (sem histórico de remoção)');
  assert.deepEqual(insertedTags, [{ opp: 77, tag: 10 }]);
});
