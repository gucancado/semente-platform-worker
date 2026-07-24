/**
 * tests/whatsapp/opportunity-read.test.ts
 *
 * Testes PUROS (pool fake inspecionável, sem Postgres nem env de servidor) do
 * resumo de oportunidades exposto pela leitura de conversas + dos agregados novos:
 *
 *   - listThreads / searchThreads → `opportunities: {count, latest}` mapeado a
 *     partir das colunas do LATERAL; filtros opp/opp_status/opp_qualification/
 *     opp_tag_id repassados nas posições certas do array de params.
 *   - getStats → byOpportunityStatus / byQualification / byOpportunityTag contam
 *     LINHAS de whatsapp_opportunities (nunca reusam os CTEs de thread).
 *   - getTimeseries → `oportunidades` deriva de created_at por bucket; `ganhas`
 *     de closed_at com status='ganho' por bucket.
 *
 * Estes módulos (read-queries/stats/timeseries) NÃO carregam o env do servidor —
 * por isso o teste roda localmente, ao contrário de stats-routes/timeseries-routes,
 * que importam read-routes.js (env-gated).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listThreads, searchThreads } from '../../src/whatsapp/read-queries.js';
import { getStats } from '../../src/whatsapp/stats.js';
import { getTimeseries } from '../../src/whatsapp/timeseries.js';

// ── pool fake: devolve `rows` fixos, grava cada chamada (text+params) ──────────
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

// Linha de thread no shape que a query de listThreads devolve (colunas do SELECT).
function threadRow(over: Record<string, any> = {}) {
  return {
    identifier: '+5511999999999',
    last_at: new Date('2026-07-10T12:00:00.000Z'),
    min_created: new Date('2026-07-01T12:00:00.000Z'),
    count: 3,
    last_text: 'oi',
    is_group: false,
    name: 'Contato',
    not_lead: false,
    lead_stage: null,
    lead_temperature: null,
    lead_source: null,
    disqualify_reason: null,
    tags: [],
    opportunity_count: 0,
    opportunity_latest: null,
    first_inbound_text: null,
    ...over,
  };
}

// Linha de hit de busca no shape da query de searchThreads.
function hitRow(over: Record<string, any> = {}) {
  return {
    identifier: '+5511999999999',
    match_count: 2,
    last_match_at: new Date('2026-07-10T12:00:00.000Z'),
    snippet: 'contexto do match',
    is_group: false,
    name: 'Contato',
    not_lead: false,
    lead_stage: null,
    lead_temperature: null,
    lead_source: null,
    disqualify_reason: null,
    tags: [],
    opportunity_count: 0,
    opportunity_latest: null,
    ...over,
  };
}

const LATEST = {
  id: 5,
  status: 'ganho',
  qualification: 'qualificado',
  title: 'Negócio X',
  tags: [{ id: 1, name: 'VIP', color: 'warn' }],
};

// =============================================================================
// listThreads — resumo de oportunidades
// =============================================================================

test('listThreads: thread com 2 opps → count=2 + latest mapeado (objeto jsonb)', async () => {
  const { pool } = fakePool(() => [threadRow({ opportunity_count: 2, opportunity_latest: LATEST })]);
  const { threads } = await listThreads(pool, { workspaceId: 'ws-1', numberId: 1, limit: 50 });
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0].opportunities, {
    count: 2,
    latest: { id: 5, status: 'ganho', qualification: 'qualificado', title: 'Negócio X', tags: [{ id: 1, name: 'VIP', color: 'warn' }] },
  });
});

test('listThreads: opportunity_latest como STRING jsonb também é parseado', async () => {
  const { pool } = fakePool(() => [threadRow({ opportunity_count: 1, opportunity_latest: JSON.stringify(LATEST) })]);
  const { threads } = await listThreads(pool, { workspaceId: 'ws-1', numberId: 1, limit: 50 });
  assert.equal(threads[0].opportunities.count, 1);
  assert.equal(threads[0].opportunities.latest!.id, 5);
  assert.deepEqual(threads[0].opportunities.latest!.tags, [{ id: 1, name: 'VIP', color: 'warn' }]);
});

test('listThreads: sem opps → {count:0, latest:null}', async () => {
  const { pool } = fakePool(() => [threadRow({ opportunity_count: 0, opportunity_latest: null })]);
  const { threads } = await listThreads(pool, { workspaceId: 'ws-1', numberId: 1, limit: 50 });
  assert.deepEqual(threads[0].opportunities, { count: 0, latest: null });
});

test('listThreads: latest = mais recente — a query ordena por created_at DESC, id DESC e pega o 1º', async () => {
  const { pool, calls } = fakePool(() => []);
  await listThreads(pool, { workspaceId: 'ws-1', numberId: 1, limit: 50 });
  const sql = calls[0].text;
  // o resumo vem de um LATERAL sobre whatsapp_opportunities, agregando o mais recente
  assert.match(sql, /LEFT JOIN LATERAL[\s\S]*FROM whatsapp_opportunities o/);
  assert.match(sql, /ORDER BY o\.created_at DESC, o\.id DESC/);
  // e usa o índice (whatsapp_number_id, identifier) — probe por número + identifier da thread
  assert.match(sql, /WHERE o\.whatsapp_number_id = \$1 AND o\.identifier = a\.identifier/);
});

test('listThreads: filtro opp=without → $14 e cláusula count=0 no SQL', async () => {
  const { pool, calls } = fakePool(() => []);
  await listThreads(pool, { workspaceId: 'ws-1', numberId: 1, limit: 50, opp: 'without' });
  assert.equal(calls[0].params[13], 'without'); // $14
  assert.match(calls[0].text, /\$14 = 'without' AND COALESCE\(os\.opportunity_count, 0\) = 0/);
});

test('listThreads: filtro opp=with → $14 e cláusula count>0 no SQL', async () => {
  const { pool, calls } = fakePool(() => []);
  await listThreads(pool, { workspaceId: 'ws-1', numberId: 1, limit: 50, opp: 'with' });
  assert.equal(calls[0].params[13], 'with');
  assert.match(calls[0].text, /\$14 = 'with' AND COALESCE\(os\.opportunity_count, 0\) > 0/);
});

test('listThreads: opp_status / opp_qualification / opp_tag_id repassados em $15/$16/$17', async () => {
  const { pool, calls } = fakePool(() => []);
  await listThreads(pool, {
    workspaceId: 'ws-1', numberId: 1, limit: 50,
    oppStatus: 'em_andamento', oppQualification: 'qualificado', oppTagId: 42,
  });
  const { params, text } = calls[0];
  assert.equal(params[14], 'em_andamento'); // $15
  assert.equal(params[15], 'qualificado');  // $16
  assert.equal(params[16], 42);             // $17
  // o filtro por tag junta opportunity_tags e casa o índice por número/identifier
  assert.match(text, /\$17::bigint IS NULL OR EXISTS[\s\S]*JOIN whatsapp_opportunity_tags oft/);
});

// =============================================================================
// searchThreads — mesmo resumo + mesmos filtros no SearchHit
// =============================================================================

test('searchThreads: hit carrega o mesmo resumo opportunities', async () => {
  const { pool } = fakePool(() => [hitRow({ opportunity_count: 2, opportunity_latest: LATEST })]);
  const { results } = await searchThreads(pool, { workspaceId: 'ws-1', numberId: 1, query: 'x' });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].opportunities, {
    count: 2,
    latest: { id: 5, status: 'ganho', qualification: 'qualificado', title: 'Negócio X', tags: [{ id: 1, name: 'VIP', color: 'warn' }] },
  });
});

test('searchThreads: filtros opp/status/qualification/tag em $11..$14', async () => {
  const { pool, calls } = fakePool(() => []);
  await searchThreads(pool, {
    workspaceId: 'ws-1', numberId: 1, query: 'x',
    opp: 'without', oppStatus: 'perdido', oppQualification: 'desqualificado', oppTagId: 7,
  });
  const { params, text } = calls[0];
  assert.equal(params[10], 'without');       // $11
  assert.equal(params[11], 'perdido');       // $12
  assert.equal(params[12], 'desqualificado'); // $13
  assert.equal(params[13], 7);               // $14
  assert.match(text, /FROM whatsapp_opportunities o/);
  assert.match(text, /ORDER BY o\.created_at DESC, o\.id DESC/);
});

// =============================================================================
// getStats — agregados de ENTIDADE (nunca reusam os CTEs de thread)
// =============================================================================

test('getStats: byOpportunityStatus / byQualification / byOpportunityTag contam linhas da entidade', async () => {
  const { pool, calls } = fakePool((text) => {
    if (/SELECT o\.status AS key/.test(text)) return [{ key: 'em_andamento', cnt: 3 }, { key: 'ganho', cnt: 1 }];
    if (/SELECT o\.qualification AS key/.test(text)) return [{ key: 'qualificado', cnt: 2 }, { key: 'indefinido', cnt: 1 }];
    if (/JOIN whatsapp_opportunity_tags ot/.test(text)) return [{ key: 'VIP', cnt: 4 }];
    return []; // main/stage/temperature/source/ingest/tag/hidden → zerados por default
  });

  const stats = await getStats(pool, { workspaceId: 'ws-1', numberId: 1, since: '2026-07-01T00:00:00Z', until: '2026-07-31T23:59:59Z' });
  assert.deepEqual(stats.byOpportunityStatus, { em_andamento: 3, ganho: 1 });
  assert.deepEqual(stats.byQualification, { qualificado: 2, indefinido: 1 });
  assert.deepEqual(stats.byOpportunityTag, { VIP: 4 });

  // REGRA CRÍTICA da spec §5.1: os 3 agregados NÃO podem reusar threads_in_period/
  // threads_scoped (colapsam identifier entre números). Devem varrer a entidade direto.
  const entityCalls = calls.filter(c =>
    /SELECT o\.status AS key/.test(c.text) ||
    /SELECT o\.qualification AS key/.test(c.text) ||
    /JOIN whatsapp_opportunity_tags ot/.test(c.text));
  assert.equal(entityCalls.length, 3);
  for (const c of entityCalls) {
    assert.doesNotMatch(c.text, /threads_in_period|threads_scoped/, 'agregado de opp não pode reusar CTE de thread');
    assert.match(c.text, /FROM whatsapp_opportunities o/);
    // escopo autoritativo: workspace + número + janela por created_at da própria opp
    assert.match(c.text, /o\.workspace_id = \$1/);
    assert.match(c.text, /o\.created_at >= \$3/);
    // params = slice(0,4) = [workspaceId, numberId, since, until]
    assert.deepEqual(c.params, ['ws-1', 1, '2026-07-01T00:00:00Z', '2026-07-31T23:59:59Z']);
  }
});

test('getStats: sem opps → os 3 records vêm vazios (aditivo, não quebra o shape)', async () => {
  const { pool } = fakePool(() => []);
  const stats = await getStats(pool, { workspaceId: 'ws-1' });
  assert.deepEqual(stats.byOpportunityStatus, {});
  assert.deepEqual(stats.byQualification, {});
  assert.deepEqual(stats.byOpportunityTag, {});
  // campos pré-existentes seguem presentes
  assert.equal(stats.total, 0);
  assert.deepEqual(stats.byKind, { dm: 0, group: 0 });
});

// =============================================================================
// getTimeseries — oportunidades (created_at) + ganhas (closed_at, status='ganho')
// =============================================================================

test('getTimeseries: mapeia oportunidades e ganhas por bucket', async () => {
  const { pool } = fakePool(() => [
    { bucket: '2026-07-01', total: 5, leads: 3, oportunidades: 2, ganhas: 1 },
    { bucket: '2026-07-02', total: 0, leads: 0, oportunidades: 0, ganhas: 0 },
  ]);
  const { series } = await getTimeseries(pool, { workspaceId: 'ws-1', numberId: 1, since: '2026-07-01T03:00:00Z', until: '2026-07-03T02:59:59Z', bucket: 'day' });
  assert.equal(series.length, 2);
  assert.deepEqual(series[0], { bucketStart: '2026-07-01', total: 5, leads: 3, oportunidades: 2, ganhas: 1 });
  assert.equal(series[1].oportunidades, 0);
  assert.equal(series[1].ganhas, 0);
});

test('getTimeseries: oportunidades deriva de created_at; ganhas de closed_at + status=ganho', async () => {
  const { pool, calls } = fakePool(() => []);
  await getTimeseries(pool, { workspaceId: 'ws-1', since: '2026-07-01T03:00:00Z', until: '2026-07-31T02:59:59Z', bucket: 'day' });
  const sql = calls[0].text;
  // oportunidades = COUNT por bucket de created_at
  assert.match(sql, /opportunity_created AS \([\s\S]*FROM whatsapp_opportunities o[\s\S]*o\.created_at >= \$3::timestamptz/);
  assert.match(sql, /COUNT\(\*\)::int AS oportunidades/);
  // ganhas = COUNT por bucket de closed_at com status='ganho'
  assert.match(sql, /opportunity_won AS \([\s\S]*o\.status = 'ganho'[\s\S]*o\.closed_at >= \$3::timestamptz/);
  assert.match(sql, /COUNT\(\*\)::int AS ganhas/);
  // a derivação antiga (lead_stage IN (...)) sumiu
  assert.doesNotMatch(sql, /lead_stage IN \('qualificado', 'cliente'\)/);
});

test('getTimeseries: derivação antiga por bucket de atividade também usa a entidade', async () => {
  const { pool, calls } = fakePool(() => []);
  await getTimeseries(pool, { workspaceId: 'ws-1', since: '2026-07-01T03:00:00Z', until: '2026-07-31T02:59:59Z', bucket: 'day', periodBasis: 'activity' });
  const sql = calls[0].text;
  assert.match(sql, /opportunity_created AS/);
  assert.match(sql, /opportunity_won AS/);
  assert.doesNotMatch(sql, /FILTER \(WHERE tm\.lead_stage IN/);
});
