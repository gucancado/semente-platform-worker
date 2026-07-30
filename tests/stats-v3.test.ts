// tests/stats-v3.test.ts
//
// PURO (DB-free) — ripple de LEITURA do tri-state (Task 7, spec v3 §5/§10).
// Run: node --import tsx --test tests/stats-v3.test.ts
//
// Cobre, com pool fake inspecionável (sem Postgres nem env de servidor):
//   1. Shape novo do Stats: byLeadStatus tri-bucket + byLossReason.
//   2. leadFilterSql pros 3 valores + 'indefinido' + 'all'.
//   3. triage.queue = query própria em whatsapp_opportunities (não CTE de thread),
//      opps em_andamento + is_lead IS NULL, params [ws, number].
//   4. Exclusão nao_lead nos agregados de opp (status/qualification/tag/lossReason).
//   5. byQualification deriva de is_qualified (CASE) mas mantém chaves string.
//   6. Derivação tri-state de leadStatus em listThreads (is_lead null/true/false).
//   7. Conversão opp_qualification (alias string) → token do predicado sobre is_qualified.
//   8. opportunities.latest ganha isQualified/lossReason (qualification derivada).
//   9. timeseries: exclusão nao_lead + leads = is_lead=TRUE apenas.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStats } from '../src/whatsapp/stats.js';
import { listThreads, searchThreads, oppQualificationToken } from '../src/whatsapp/read-queries.js';
import { getTimeseries } from '../src/whatsapp/timeseries.js';
import { leadFilterSql } from '../src/whatsapp/lead-filter.js';

// ── pool fake: devolve `rows` por handler, grava cada chamada (text+params) ──────
function fakePool(handler: (text: string, params: any[]) => any[]) {
  const calls: { text: string; params: any[] }[] = [];
  const pool = {
    query(text: string, params: any[] = []) {
      calls.push({ text, params });
      return Promise.resolve({ rows: handler(text, params), rowCount: 0 });
    },
  } as any;
  return { pool, calls };
}

// Handler default de getStats: main row + agregados de opp; buckets de thread zerados.
function statsHandler(over: {
  main?: Record<string, number>;
  triage?: number;
  status?: any[];
  qualification?: any[];
  tag?: any[];
  loss?: any[];
} = {}) {
  const main = {
    total: 6, group_count: 1, dm_count: 5,
    lead_count: 2, not_lead_count: 1, indefinido_count: 3,
    ...(over.main ?? {}),
  };
  return (text: string): any[] => {
    if (/AS triage_queue/.test(text)) return [{ triage_queue: over.triage ?? 4 }];
    if (/kind_match/.test(text)) return [main];
    if (/COALESCE\(o\.loss_reason, 'null'\) AS key/.test(text)) return over.loss ?? [];
    if (/SELECT o\.status AS key/.test(text)) return over.status ?? [];
    if (/o\.is_qualified IS NULL THEN 'indefinido'/.test(text)) return over.qualification ?? [];
    if (/JOIN whatsapp_opportunity_tags ot/.test(text)) return over.tag ?? [];
    return [];
  };
}

const WINDOW = { since: '2026-07-01T00:00:00Z', until: '2026-07-31T23:59:59Z' };

// Linha de thread no shape que listThreads devolve (colunas do SELECT v3).
function threadRow(over: Record<string, any> = {}) {
  return {
    identifier: '+5511999999999',
    last_at: new Date('2026-07-10T12:00:00.000Z'),
    min_created: new Date('2026-07-01T12:00:00.000Z'),
    count: 3, last_text: 'oi', is_group: false, name: 'Contato',
    is_lead: true,
    lead_stage: null, lead_temperature: null, lead_source: null, disqualify_reason: null,
    tags: [], opportunity_count: 0, opportunity_latest: null, first_inbound_text: null,
    ...over,
  };
}

// =============================================================================
// 1. Shape novo — byLeadStatus tri-bucket + byLossReason
// =============================================================================

test('getStats: byLeadStatus vira {lead, not_lead, indefinido} + byLossReason presente', async () => {
  const { pool } = fakePool(statsHandler({
    main: { total: 6, group_count: 1, dm_count: 5, lead_count: 2, not_lead_count: 1, indefinido_count: 3 },
    loss: [{ key: 'preco', cnt: 2 }, { key: 'null', cnt: 1 }],
    qualification: [{ key: 'qualificado', cnt: 1 }, { key: 'indefinido', cnt: 2 }],
    status: [{ key: 'ganho', cnt: 1 }],
    tag: [{ key: 'VIP', cnt: 1 }],
    triage: 5,
  }));
  const stats = await getStats(pool, { workspaceId: 'ws', numberId: 1, ...WINDOW });

  assert.deepEqual(stats.byLeadStatus, { lead: 2, not_lead: 1, indefinido: 3 });
  assert.deepEqual(stats.byLossReason, { preco: 2, null: 1 });
  // byQualification mantém CHAVES STRING (derivadas do boolean), zero quebra no painel.
  assert.deepEqual(stats.byQualification, { qualificado: 1, indefinido: 2 });
  assert.deepEqual(stats.byOpportunityStatus, { ganho: 1 });
  assert.deepEqual(stats.byOpportunityTag, { VIP: 1 });
  assert.equal(stats.triage.queue, 5);
  assert.match(stats.triage.note, /novas_conversas/);
});

test('getStats: workspace vazio → byLeadStatus zerado nos 3 + byLossReason {}', async () => {
  const { pool } = fakePool(statsHandler({
    main: { total: 0, group_count: 0, dm_count: 0, lead_count: 0, not_lead_count: 0, indefinido_count: 0 },
    triage: 0,
  }));
  const stats = await getStats(pool, { workspaceId: 'ws' });
  assert.deepEqual(stats.byLeadStatus, { lead: 0, not_lead: 0, indefinido: 0 });
  assert.deepEqual(stats.byLossReason, {});
  assert.equal(stats.triage.queue, 0);
});

// =============================================================================
// 2. leadFilterSql — 3 valores + indefinido + all
// =============================================================================

test('leadFilterSql: tri-state (lead=TRUE apenas, indefinido=IS NULL) + all', () => {
  assert.equal(leadFilterSql('lead'), 'tm.is_lead = TRUE');
  assert.equal(leadFilterSql('not_lead'), 'tm.is_lead = FALSE');
  assert.equal(leadFilterSql('indefinido'), 'tm.is_lead IS NULL');
  assert.equal(leadFilterSql('all'), 'TRUE');
});

// =============================================================================
// 3. triage.queue — query própria em whatsapp_opportunities (não CTE de thread)
// =============================================================================

test('getStats: triage.queue é query própria (opps em_andamento + is_lead IS NULL), sem CTE de thread', async () => {
  const { calls, pool } = fakePool(statsHandler({ triage: 7 }));
  const stats = await getStats(pool, { workspaceId: 'ws', numberId: 9, ...WINDOW });
  assert.equal(stats.triage.queue, 7);

  const triageCall = calls.find(c => /AS triage_queue/.test(c.text));
  assert.ok(triageCall, 'query de triage.queue deve rodar');
  assert.match(triageCall!.text, /FROM whatsapp_opportunities o/);
  assert.match(triageCall!.text, /o\.status = 'em_andamento'/);
  assert.match(triageCall!.text, /tm\.is_lead IS NULL/);
  // NÃO pode reusar os CTEs de thread (colapsam identifier entre números).
  assert.doesNotMatch(triageCall!.text, /threads_in_period|threads_scoped/);
  // snapshot vivo do board: usa só [workspace, número], ignora a janela de período.
  assert.deepEqual(triageCall!.params, ['ws', 9]);
});

// =============================================================================
// 4 + 5. Exclusão nao_lead + byQualification deriva de is_qualified
// =============================================================================

test('getStats: agregados de opp EXCLUEM nao_lead e byQualification usa CASE de is_qualified', async () => {
  const { calls, pool } = fakePool(statsHandler());
  await getStats(pool, { workspaceId: 'ws', numberId: 1, ...WINDOW });

  const statusCall = calls.find(c => /SELECT o\.status AS key/.test(c.text));
  const qualCall = calls.find(c => /o\.is_qualified IS NULL THEN 'indefinido'/.test(c.text));
  const tagCall = calls.find(c => /JOIN whatsapp_opportunity_tags ot/.test(c.text));
  const lossCall = calls.find(c => /COALESCE\(o\.loss_reason, 'null'\) AS key/.test(c.text));

  for (const c of [statusCall, qualCall, tagCall, lossCall]) {
    assert.ok(c, 'agregado de opp deve rodar');
    assert.match(c!.text, /o\.loss_reason IS DISTINCT FROM 'nao_lead'/);
    assert.match(c!.text, /FROM whatsapp_opportunities o/);
    assert.doesNotMatch(c!.text, /threads_in_period|threads_scoped/);
    // janela por created_at da própria opp = params.slice(0,4)
    assert.deepEqual(c!.params, ['ws', 1, WINDOW.since, WINDOW.until]);
  }
  // byQualification NÃO lê mais a coluna legada `qualification` diretamente.
  assert.doesNotMatch(qualCall!.text, /SELECT o\.qualification AS key/);
  assert.match(qualCall!.text, /WHEN o\.is_qualified THEN 'qualificado'/);
  // byLossReason só conta perdas.
  assert.match(lossCall!.text, /o\.status = 'perdido'/);
});

// =============================================================================
// 6. Derivação tri-state de leadStatus em listThreads / searchThreads
// =============================================================================

test('listThreads: leadStatus tri-state (is_lead null → indefinido, true → lead, false → not_lead)', async () => {
  for (const [isLead, expected] of [[null, 'indefinido'], [true, 'lead'], [false, 'not_lead']] as const) {
    const { pool } = fakePool(() => [threadRow({ is_lead: isLead })]);
    const { threads } = await listThreads(pool, { workspaceId: 'ws', numberId: 1, limit: 30 });
    assert.equal(threads[0].leadStatus, expected, `is_lead=${isLead}`);
  }
});

test('searchThreads: leadStatus tri-state derivado de is_lead', async () => {
  const hit = (isLead: any) => ({
    identifier: '+55', match_count: 1, last_match_at: new Date('2026-07-10T12:00:00Z'),
    snippet: 's', is_group: false, name: 'x', is_lead: isLead,
    lead_stage: null, lead_temperature: null, lead_source: null, disqualify_reason: null,
    tags: [], opportunity_count: 0, opportunity_latest: null,
  });
  for (const [isLead, expected] of [[null, 'indefinido'], [true, 'lead'], [false, 'not_lead']] as const) {
    const { pool } = fakePool(() => [hit(isLead)]);
    const { results } = await searchThreads(pool, { workspaceId: 'ws', numberId: 1, query: 'x' });
    assert.equal(results[0].leadStatus, expected, `is_lead=${isLead}`);
  }
});

// =============================================================================
// 7. Conversão opp_qualification (alias string) → token de is_qualified
// =============================================================================

test('oppQualificationToken: qualificado→true · desqualificado→false · indefinido→null · inválido/ausente→sem filtro', () => {
  assert.equal(oppQualificationToken('qualificado'), 'true');
  assert.equal(oppQualificationToken('desqualificado'), 'false');
  assert.equal(oppQualificationToken('indefinido'), 'null');
  assert.equal(oppQualificationToken(undefined), null);
  assert.equal(oppQualificationToken('lixo'), null);
});

test('listThreads: opp_qualification vira token no $16 + predicado sobre is_qualified', async () => {
  const { pool, calls } = fakePool(() => []);
  await listThreads(pool, { workspaceId: 'ws', numberId: 1, limit: 30, oppQualification: 'qualificado' });
  assert.equal(calls[0].params[15], 'true'); // $16 = token, não 'qualificado'
  assert.match(calls[0].text, /oflt\.is_qualified IS NOT DISTINCT FROM/);
  assert.doesNotMatch(calls[0].text, /oflt\.qualification = \$16/);
});

test('searchThreads: opp_qualification vira token no $13 + predicado sobre is_qualified', async () => {
  const { pool, calls } = fakePool(() => []);
  await searchThreads(pool, { workspaceId: 'ws', numberId: 1, query: 'x', oppQualification: 'desqualificado' });
  assert.equal(calls[0].params[12], 'false'); // $13
  assert.match(calls[0].text, /oflt\.is_qualified IS NOT DISTINCT FROM/);
});

// =============================================================================
// 8. opportunities.latest ganha isQualified/lossReason (qualification derivada)
// =============================================================================

test('listThreads: latest expõe isQualified/lossReason e deriva qualification de is_qualified', async () => {
  const latest = { id: 5, status: 'perdido', is_qualified: false, loss_reason: 'preco', title: 'X', tags: [] };
  const { pool, calls } = fakePool(() => [threadRow({ opportunity_count: 1, opportunity_latest: latest })]);
  const { threads } = await listThreads(pool, { workspaceId: 'ws', numberId: 1, limit: 30 });
  assert.deepEqual(threads[0].opportunities.latest, {
    id: 5, status: 'perdido', isQualified: false, lossReason: 'preco', qualification: 'desqualificado', title: 'X', tags: [],
  });
  // o jsonb builder da LATERAL agora inclui is_qualified + loss_reason
  assert.match(calls[0].text, /'is_qualified', o\.is_qualified/);
  assert.match(calls[0].text, /'loss_reason', o\.loss_reason/);
});

test('listThreads: latest com is_qualified NULL → qualification=indefinido, isQualified=null', async () => {
  const latest = { id: 9, status: 'em_andamento', is_qualified: null, loss_reason: null, title: null, tags: [] };
  const { pool } = fakePool(() => [threadRow({ opportunity_count: 1, opportunity_latest: latest })]);
  const { threads } = await listThreads(pool, { workspaceId: 'ws', numberId: 1, limit: 30 });
  assert.equal(threads[0].opportunities.latest!.isQualified, null);
  assert.equal(threads[0].opportunities.latest!.qualification, 'indefinido');
  assert.equal(threads[0].opportunities.latest!.lossReason, null);
});

// =============================================================================
// 9. timeseries — exclusão nao_lead + leads = is_lead=TRUE apenas
// =============================================================================

test('getTimeseries: oportunidades/ganhas excluem nao_lead e leads conta só is_lead=TRUE', async () => {
  const { pool, calls } = fakePool(() => []);
  await getTimeseries(pool, { workspaceId: 'ws', since: '2026-07-01T03:00:00Z', until: '2026-07-31T02:59:59Z', bucket: 'day' });
  const sql = calls[0].text;
  assert.match(sql, /opportunity_created AS \([\s\S]*loss_reason IS DISTINCT FROM 'nao_lead'/);
  assert.match(sql, /opportunity_won AS \([\s\S]*loss_reason IS DISTINCT FROM 'nao_lead'/);
  // leads TRI-STATE: só is_lead=TRUE (NULL não conta mais)
  assert.match(sql, /FILTER \(WHERE tm\.is_lead = TRUE\)::int AS leads/);
  assert.doesNotMatch(sql, /tm\.is_lead IS NULL OR tm\.is_lead = TRUE/);
});
