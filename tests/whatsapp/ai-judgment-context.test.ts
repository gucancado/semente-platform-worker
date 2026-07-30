// tests/whatsapp/ai-judgment-context.test.ts  (PURO — fake pool, sem DB)
//
// Prova a montagem determinística do JudgmentContext a partir de rows fake: split
// novas×cauda com caps, truncamento de texto, seleção de opp aberta/última fechada,
// catálogos (loss reasons ativos, não-lead labels, tags com description), settings e
// a delegação de sticky à opp certa (aberta > fechada > null).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildJudgmentContext } from '../../src/whatsapp/ai-judgment-context.js';

type Rows = Record<string, unknown>[];
type RouteFn = (params: unknown[]) => Rows;
type Routes = Partial<Record<string, Rows | RouteFn>>;

function pickRoute(sql: string): string | null {
  if (sql.includes('/* ctx:messages:new */')) return 'messages:new';
  if (sql.includes('/* ctx:messages:tail */')) return 'messages:tail';
  if (sql.includes('/* ctx:triage */')) return 'triage';
  if (sql.includes('/* ctx:opps */')) return 'opps';
  if (sql.includes('/* ctx:settings */')) return 'settings';
  if (sql.includes('/* ctx:tags */')) return 'tags';
  if (sql.includes('whatsapp_thread_meta_log')) return 'sticky_lead';
  if (sql.includes('whatsapp_opportunity_events')) return 'sticky_opp';
  if (sql.includes('whatsapp_loss_reasons')) return 'loss_reasons';
  if (sql.includes('whatsapp_disqualify_reasons')) return 'not_lead_reasons';
  return null;
}

function fakePool(routes: Routes): Pool {
  return {
    async query(sql: string, params: unknown[] = []) {
      const key = pickRoute(sql);
      if (!key) throw new Error(`unrouted SQL: ${sql.slice(0, 90)}`);
      const r = routes[key];
      const rows = typeof r === 'function' ? r(params) : r ?? [];
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
}

const NO_STICKY = { sticky_lead: [{ is_lead: false }], sticky_opp: [] as Rows };

test('sem watermark: pega as mais recentes, ordena crescente, trunca 500 chars', async () => {
  const long = 'x'.repeat(600);
  const pool = fakePool({
    ...NO_STICKY,
    'messages:new': [
      // vem do banco em DESC; o módulo reverte pra ASC
      { direction: 'inbound', text: 'terceira', created_at: new Date('2026-07-30T10:03:00Z'), id: 3 },
      { direction: 'outbound', text: long, created_at: new Date('2026-07-30T10:02:00Z'), id: 2 },
      { direction: 'inbound', text: 'primeira', created_at: new Date('2026-07-30T10:01:00Z'), id: 1 },
    ],
    settings: [{ new_opp_after_days: 30, ai_lead_guidance: null, ai_qualified_guidance: null }],
  });

  const ctx = await buildJudgmentContext(pool, {
    numberId: 1,
    identifier: 'c',
    workspaceId: 'ws',
    watermark: null,
  });

  assert.deepEqual(
    ctx.messages.map((m) => m.text.slice(0, 8)),
    ['primeira', 'xxxxxxxx', 'terceira'],
  );
  assert.equal(ctx.messages[1]!.text.length, 500); // truncado
  assert.equal(ctx.lastMessageAt, '2026-07-30T10:03:00.000Z');
  assert.equal(ctx.watermark, null);
});

test('com watermark: cauda (<=wm) + novas (>wm), cauda antes das novas', async () => {
  const pool = fakePool({
    ...NO_STICKY,
    'messages:tail': [
      // DESC do banco; módulo reverte
      { direction: 'inbound', text: 'cauda-b', created_at: new Date('2026-07-30T09:50:00Z'), id: 11 },
      { direction: 'inbound', text: 'cauda-a', created_at: new Date('2026-07-30T09:40:00Z'), id: 10 },
    ],
    'messages:new': [
      // DESC do banco (novas): módulo reverte pra ASC
      { direction: 'inbound', text: 'nova-2', created_at: new Date('2026-07-30T10:20:00Z'), id: 21 },
      { direction: 'outbound', text: 'nova-1', created_at: new Date('2026-07-30T10:10:00Z'), id: 20 },
    ],
    settings: [{ new_opp_after_days: 30, ai_lead_guidance: null, ai_qualified_guidance: null }],
  });

  const ctx = await buildJudgmentContext(pool, {
    numberId: 1,
    identifier: 'c',
    workspaceId: 'ws',
    watermark: '2026-07-30T10:00:00.000Z',
  });

  assert.deepEqual(
    ctx.messages.map((m) => m.text),
    ['cauda-a', 'cauda-b', 'nova-1', 'nova-2'],
  );
  assert.equal(ctx.lastMessageAt, '2026-07-30T10:20:00.000Z');
  assert.equal(ctx.watermark, '2026-07-30T10:00:00.000Z');
});

test('janela com >80 novas: mantém as MAIS RECENTES; lastMessageAt = max real', async () => {
  const base = Date.UTC(2026, 6, 30, 0, 0, 0);
  // 90 novas, entregues DESC (mais nova primeiro, i=90) como o banco faria
  const freshDesc = [];
  for (let i = 90; i >= 1; i--) {
    freshDesc.push({
      direction: 'inbound',
      text: `m${i}`,
      created_at: new Date(base + i * 60_000),
      id: i,
    });
  }
  const pool = fakePool({
    ...NO_STICKY,
    'messages:tail': [],
    'messages:new': freshDesc,
    settings: [{ new_opp_after_days: 30, ai_lead_guidance: null, ai_qualified_guidance: null }],
  });

  const ctx = await buildJudgmentContext(pool, {
    numberId: 1,
    identifier: 'c',
    workspaceId: 'ws',
    watermark: '2026-07-29T00:00:00.000Z',
  });

  assert.equal(ctx.messages.length, 80);
  assert.equal(ctx.messages[0]!.text, 'm11'); // dropou as antigas m1..m10, não as recentes
  assert.equal(ctx.messages[79]!.text, 'm90');
  assert.equal(ctx.lastMessageAt, new Date(base + 90 * 60_000).toISOString());
});

test('opps: escolhe aberta e última fechada; sticky delega à aberta', async () => {
  let stickyOppParam: unknown;
  const pool = fakePool({
    'messages:new': [],
    triage: [{ is_lead: true, lead_source: 'ads', notes: 'veio do anúncio' }],
    opps: [
      // DESC created_at: [aberta mais nova, fechada]
      {
        id: 200,
        title: 'Plano X',
        status: 'em_andamento',
        is_qualified: null,
        loss_reason: null,
        created_at: new Date('2026-07-20T00:00:00Z'),
        updated_at: new Date('2026-07-29T00:00:00Z'),
        closed_at: null,
        tag_names: ['VIP'],
      },
      {
        id: 100,
        title: null,
        status: 'perdido',
        is_qualified: false,
        loss_reason: 'sem_orcamento',
        created_at: new Date('2026-07-01T00:00:00Z'),
        updated_at: new Date('2026-07-05T00:00:00Z'),
        closed_at: new Date('2026-07-05T00:00:00Z'),
        tag_names: [],
      },
    ],
    settings: [{ new_opp_after_days: 45, ai_lead_guidance: 'g1', ai_qualified_guidance: 'g2' }],
    sticky_lead: [{ is_lead: false }],
    sticky_opp: (params) => {
      stickyOppParam = params[0];
      return [{ is_qualified: true, status: false, loss_reason: false, tags_removed: [] }];
    },
  });

  const ctx = await buildJudgmentContext(pool, {
    numberId: 1,
    identifier: 'c',
    workspaceId: 'ws',
    watermark: null,
  });

  assert.equal(ctx.openOpp?.id, 200);
  assert.deepEqual(ctx.openOpp?.tags, ['VIP']);
  assert.equal(ctx.lastClosedOpp?.id, 100);
  assert.equal(ctx.lastClosedOpp?.isQualified, false);
  assert.equal(ctx.lastClosedOpp?.closedAt, '2026-07-05T00:00:00.000Z');
  assert.equal(ctx.triage.isLead, true);
  assert.equal(ctx.triage.leadSource, 'ads');
  assert.equal(ctx.settings.newOppAfterDays, 45);
  // sticky computado contra a opp ABERTA (200), não a fechada
  assert.equal(stickyOppParam, 200);
  assert.equal(ctx.sticky.isQualified, true);
});

test('sem opp aberta mas com fechada: sticky delega à última fechada', async () => {
  let stickyOppParam: unknown = 'unset';
  const pool = fakePool({
    'messages:new': [],
    opps: [
      {
        id: 100,
        title: null,
        status: 'ganho',
        is_qualified: true,
        loss_reason: null,
        created_at: new Date('2026-07-01T00:00:00Z'),
        updated_at: new Date('2026-07-05T00:00:00Z'),
        closed_at: new Date('2026-07-05T00:00:00Z'),
        tag_names: [],
      },
    ],
    settings: [{ new_opp_after_days: 30, ai_lead_guidance: null, ai_qualified_guidance: null }],
    sticky_lead: [{ is_lead: false }],
    sticky_opp: (params) => {
      stickyOppParam = params[0];
      return [];
    },
  });

  const ctx = await buildJudgmentContext(pool, {
    numberId: 1,
    identifier: 'c',
    workspaceId: 'ws',
    watermark: null,
  });

  assert.equal(ctx.openOpp, null);
  assert.equal(ctx.lastClosedOpp?.id, 100);
  assert.equal(stickyOppParam, 100);
});

test('catálogos: loss reasons ativos filtrados; não-lead vira labels; tags com description', async () => {
  const pool = fakePool({
    'messages:new': [],
    settings: [{ new_opp_after_days: 30, ai_lead_guidance: null, ai_qualified_guidance: null }],
    sticky_lead: [{ is_lead: false }],
    sticky_opp: [],
    loss_reasons: [
      { id: 1, code: 'preco', label: 'Preço', description: 'achou caro', active: true, usage_count: 3 },
      { id: 2, code: 'sumido', label: 'Sumiu', description: null, active: false, usage_count: 0 },
    ],
    not_lead_reasons: [
      { code: 'spam', label: 'Spam', active: true, sort_order: 1 },
      { code: 'fornecedor', label: 'Fornecedor', active: true, sort_order: 2 },
    ],
    tags: [
      { id: 10, name: 'Bairro X', description: 'região sul' },
      { id: 11, name: 'Plano saúde', description: null },
    ],
  });

  const ctx = await buildJudgmentContext(pool, {
    numberId: 1,
    identifier: 'c',
    workspaceId: 'ws',
    watermark: null,
  });

  assert.deepEqual(ctx.lossReasons, [{ code: 'preco', label: 'Preço', description: 'achou caro' }]);
  assert.deepEqual(ctx.notLeadReasons, [
    { code: 'spam', label: 'Spam' },
    { code: 'fornecedor', label: 'Fornecedor' },
  ]);
  assert.deepEqual(ctx.tags, [
    { id: 10, name: 'Bairro X', description: 'região sul' },
    { id: 11, name: 'Plano saúde', description: null },
  ]);
});

test('thread sem meta e sem opp: triagem toda null, settings default, lastMessageAt null', async () => {
  const pool = fakePool({
    'messages:tail': [],
    'messages:new': [],
    // sem triage/opps/settings rows
    sticky_lead: [],
    sticky_opp: [],
  });

  const ctx = await buildJudgmentContext(pool, {
    numberId: 1,
    identifier: 'novo',
    workspaceId: 'ws',
    watermark: '2026-07-30T00:00:00.000Z',
  });

  assert.deepEqual(ctx.triage, { isLead: null, leadSource: null, notes: null });
  assert.equal(ctx.openOpp, null);
  assert.equal(ctx.lastClosedOpp, null);
  assert.equal(ctx.settings.newOppAfterDays, 30);
  assert.equal(ctx.lastMessageAt, null); // sem mensagens → null defensivo (D5 guarda)
  assert.equal(ctx.sticky.isLead, false);
});
