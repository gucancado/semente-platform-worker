/**
 * tests/opportunities-v3.test.ts
 *
 * Testes PUROS (sem Postgres nem env de servidor) do data layer v3 de oportunidades:
 *   - mapOpportunity: snake→camel com as colunas novas (is_qualified/loss_reason) e
 *     qualification derivada (com fallback pra coluna legada quando is_qualified some).
 *   - resolveIsQualifiedFilter: alias tri-state qualification↔isQualified do filtro.
 *   - countOpenOpportunities: SQL shape via client fake (só em_andamento do par).
 *   - applyThreadLeadTrue: side-effect da thread — upsert is_lead=TRUE sempre, log
 *     em whatsapp_thread_meta_log SÓ SE o valor anterior era diferente de TRUE
 *     (cross-task OBRIGATÓRIA: log incondicional travaria o sticky da IA num title-edit).
 *
 * opportunities.ts só importa TIPOS de 'pg' + módulos puros (opportunity-core /
 * conversation-lock), então não carrega o env do servidor — roda localmente.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapOpportunity,
  resolveIsQualifiedFilter,
  countOpenOpportunities,
  applyThreadLeadTrue,
} from '../src/whatsapp/opportunities.js';

// ── client fake: devolve `rows` do handler, grava cada chamada (text+params) ────
function fakeClient(handler: (text: string, params: any[]) => any[]) {
  const calls: { text: string; params: any[] }[] = [];
  const client = {
    query(text: string, params: any[] = []) {
      calls.push({ text, params });
      return Promise.resolve({ rows: handler(text, params), rowCount: 0 });
    },
  } as any;
  return { client, calls };
}

// =============================================================================
// mapOpportunity — snake→camel + qualification derivada
// =============================================================================

const baseRow = {
  id: '7',
  identifier: '+5511',
  title: 'X',
  status: 'perdido',
  created_at: new Date('2026-07-01T00:00:00.000Z'),
  updated_at: new Date('2026-07-02T00:00:00.000Z'),
  closed_at: new Date('2026-07-02T00:00:00.000Z'),
  created_by: 'u1',
  tags: [],
};

test('mapOpportunity expõe isQualified/lossReason e deriva qualification de is_qualified', () => {
  const q = mapOpportunity({ ...baseRow, is_qualified: true, loss_reason: null });
  assert.equal(q.isQualified, true);
  assert.equal(q.qualification, 'qualificado');
  assert.equal(q.lossReason, null);

  const d = mapOpportunity({ ...baseRow, is_qualified: false, loss_reason: 'nao_lead' });
  assert.equal(d.isQualified, false);
  assert.equal(d.qualification, 'desqualificado');
  assert.equal(d.lossReason, 'nao_lead');

  const i = mapOpportunity({ ...baseRow, is_qualified: null, loss_reason: null });
  assert.equal(i.isQualified, null);
  assert.equal(i.qualification, 'indefinido');
});

test('mapOpportunity sem coluna is_qualified cai na qualification legada', () => {
  const legacy = mapOpportunity({
    id: 1, identifier: 'c', title: null, status: 'em_andamento',
    qualification: 'qualificado', created_at: new Date(), updated_at: new Date(),
    closed_at: null, created_by: null, tags: [],
  });
  assert.equal(legacy.qualification, 'qualificado');
  assert.equal(legacy.isQualified, null);
  assert.equal(legacy.lossReason, null);
});

// =============================================================================
// resolveIsQualifiedFilter — alias tri-state
// =============================================================================

test('resolveIsQualifiedFilter: isQualified explícito tem precedência (inclui null=IS NULL)', () => {
  assert.equal(resolveIsQualifiedFilter({ isQualified: true }), true);
  assert.equal(resolveIsQualifiedFilter({ isQualified: false }), false);
  assert.equal(resolveIsQualifiedFilter({ isQualified: null }), null);
  assert.equal(resolveIsQualifiedFilter({}), undefined); // sem filtro
  // isQualified explícito vence o alias
  assert.equal(resolveIsQualifiedFilter({ isQualified: null, qualification: 'qualificado' }), null);
});

test('resolveIsQualifiedFilter: alias qualification→boolean|null', () => {
  assert.equal(resolveIsQualifiedFilter({ qualification: 'qualificado' }), true);
  assert.equal(resolveIsQualifiedFilter({ qualification: 'desqualificado' }), false);
  assert.equal(resolveIsQualifiedFilter({ qualification: 'indefinido' }), null);
  assert.equal(resolveIsQualifiedFilter({ qualification: 'lixo' }), undefined);
});

// =============================================================================
// countOpenOpportunities — SQL shape (client fake)
// =============================================================================

test('countOpenOpportunities: conta só em_andamento do par e devolve inteiro', async () => {
  const { client, calls } = fakeClient(() => [{ n: 3 }]);
  const n = await countOpenOpportunities(client, 9, '+5511');
  assert.equal(n, 3);
  const first = calls[0]!;
  assert.match(first.text, /FROM whatsapp_opportunities/);
  assert.match(first.text, /status = 'em_andamento'/);
  assert.match(first.text, /whatsapp_number_id = \$1 AND identifier = \$2/);
  assert.deepEqual(first.params, [9, '+5511']);
});

test('countOpenOpportunities: sem rows → 0', async () => {
  const { client } = fakeClient(() => []);
  assert.equal(await countOpenOpportunities(client, 1, 'c'), 0);
});

// =============================================================================
// applyThreadLeadTrue — upsert sempre, log só quando mudou (cross-task obrigatório)
// =============================================================================

const isMetaUpsert = (t: string) => /INSERT INTO whatsapp_thread_meta\b/.test(t);
const isMetaLog = (t: string) => /INSERT INTO whatsapp_thread_meta_log/.test(t);

test('applyThreadLeadTrue: prev is_lead=TRUE faz upsert TRUE mas NÃO loga', async () => {
  const { client, calls } = fakeClient((t) =>
    /SELECT is_lead FROM whatsapp_thread_meta/.test(t) ? [{ is_lead: true }] : []);
  await applyThreadLeadTrue(client, { numberId: 1, identifier: 'c', actor: 'u1' });
  const upserts = calls.filter((c) => isMetaUpsert(c.text));
  const logs = calls.filter((c) => isMetaLog(c.text));
  assert.equal(upserts.length, 1);
  assert.match(upserts[0]!.text, /is_lead = TRUE/);
  assert.equal(logs.length, 0, 'não deve logar quando já era TRUE (senão trava o sticky da IA)');
});

test('applyThreadLeadTrue: sem row anterior loga com old_value=null', async () => {
  const { client, calls } = fakeClient(() => []); // SELECT vazio
  await applyThreadLeadTrue(client, { numberId: 1, identifier: 'c', actor: 'u1' });
  const logs = calls.filter((c) => isMetaLog(c.text));
  assert.equal(logs.length, 1);
  // new_value 'is_lead'/'true' são literais no SQL; params = [numberId, identifier, old_value, actor]
  assert.deepEqual(logs[0]!.params, [1, 'c', null, 'u1']);
});

test('applyThreadLeadTrue: prev is_lead=FALSE loga false→true', async () => {
  const { client, calls } = fakeClient((t) =>
    /SELECT is_lead FROM whatsapp_thread_meta/.test(t) ? [{ is_lead: false }] : []);
  await applyThreadLeadTrue(client, { numberId: 2, identifier: 'x', actor: 'u9' });
  const logs = calls.filter((c) => isMetaLog(c.text));
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0]!.params, [2, 'x', 'false', 'u9']);
});
