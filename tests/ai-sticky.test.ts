// tests/ai-sticky.test.ts
//
// PURO (DB-free) — precedência humana por dimensão (Task D2, spec v3 §6).
// Run: node --import tsx --test tests/ai-sticky.test.ts
//
// Cobre, com client fake inspecionável (sem Postgres nem env de servidor):
//   1. Predicado humano: 'ai'/'system'/'migration'/NULL → NÃO trava; uuid/label → trava.
//   2. computeSticky sem opp (opportunityId null): NÃO consulta whatsapp_opportunity_events;
//      flags de opp todas false + lista vazia; is_lead ainda deriva do thread_meta_log.
//   3. is_lead sticky ⇐ whatsapp_thread_meta_log field='is_lead' com ator humano.
//   4. Dimensões de opp (isQualified/status/lossReason) ⇐ agregado de eventos humanos.
//   5. tagsRemovedByHuman ⇐ tag_removed humanos (new_value), lista de nomes.
//   6. SQLs carregam o predicado humano na coluna certa (actor / changed_by) + params.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSticky, isHumanActor } from '../src/whatsapp/ai-sticky.js';

// ── client fake: devolve `rows` por handler, grava cada chamada (text+params) ────
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

const isLeadRow = (v: boolean) => [{ is_lead: v }];
const oppRow = (o: Partial<{ is_qualified: boolean; status: boolean; loss_reason: boolean; tags_removed: string[] }> = {}) => [{
  is_qualified: o.is_qualified ?? false,
  status: o.status ?? false,
  loss_reason: o.loss_reason ?? false,
  tags_removed: o.tags_removed ?? [],
}];

// Roteia por tabela: thread_meta_log → lead; opportunity_events → agregado da opp.
function route(over: { lead?: boolean; opp?: ReturnType<typeof oppRow> } = {}) {
  return (text: string): any[] => {
    if (/whatsapp_thread_meta_log/.test(text)) return isLeadRow(over.lead ?? false);
    if (/whatsapp_opportunity_events/.test(text)) return over.opp ?? oppRow();
    return [];
  };
}

// =============================================================================
// 1. Predicado humano
// =============================================================================

test('isHumanActor: sistema/NULL não trava; uuid/label trava', () => {
  for (const a of ['ai', 'system', 'migration', null, undefined, '']) {
    assert.equal(isHumanActor(a as any), false, `ator ${String(a)} não deve travar`);
  }
  for (const a of ['u1', 'gustavo', '2f9c-uuid-bloquim', 'AI', 'System']) {
    assert.equal(isHumanActor(a), true, `ator ${a} deve travar (case-sensitive: só minúsculo é sistema)`);
  }
});

// =============================================================================
// 2. opportunityId null → flags de opp false, lista vazia, sem query em eventos
// =============================================================================

test('computeSticky: opportunityId null NÃO consulta eventos; flags de opp false + lista vazia', async () => {
  const { client, calls } = fakeClient(route({ lead: true }));
  const flags = await computeSticky(client, { numberId: 1, identifier: 'c', opportunityId: null });

  assert.equal(flags.isLead, true, 'is_lead ainda deriva da thread mesmo sem opp');
  assert.equal(flags.isQualified, false);
  assert.equal(flags.status, false);
  assert.equal(flags.lossReason, false);
  assert.deepEqual(flags.tagsRemovedByHuman, []);

  // Nenhuma chamada tocou whatsapp_opportunity_events.
  assert.ok(calls.every((c) => !/whatsapp_opportunity_events/.test(c.text)), 'não deve consultar eventos');
});

test('computeSticky: opportunityId null com thread não travada → tudo false', async () => {
  const { client } = fakeClient(route({ lead: false }));
  const flags = await computeSticky(client, { numberId: 9, identifier: 'x', opportunityId: null });
  assert.deepEqual(flags, { isLead: false, isQualified: false, status: false, lossReason: false, tagsRemovedByHuman: [] });
});

// =============================================================================
// 3. is_lead sticky ⇐ thread_meta_log
// =============================================================================

test('computeSticky: is_lead trava quando thread_meta_log tem is_lead humano; SQL + params certos', async () => {
  const { client, calls } = fakeClient(route({ lead: true, opp: oppRow() }));
  const flags = await computeSticky(client, { numberId: 7, identifier: '+55', opportunityId: 42 });
  assert.equal(flags.isLead, true);

  const leadCall = calls.find((c) => /whatsapp_thread_meta_log/.test(c.text))!;
  assert.ok(leadCall, 'query de is_lead deve rodar');
  assert.match(leadCall.text, /field = 'is_lead'/);
  // predicado humano NA coluna actor (não changed_by).
  assert.match(leadCall.text, /actor IS NOT NULL AND actor NOT IN \('ai', 'system', 'migration'\)/);
  assert.deepEqual(leadCall.params, [7, '+55']);
});

// =============================================================================
// 4. dimensões de opp ⇐ agregado de eventos humanos
// =============================================================================

test('computeSticky: qualification/status/loss_reason travam pelo agregado da opp', async () => {
  const { client, calls } = fakeClient(route({
    lead: false,
    opp: oppRow({ is_qualified: true, status: true, loss_reason: false }),
  }));
  const flags = await computeSticky(client, { numberId: 1, identifier: 'c', opportunityId: 55 });
  assert.equal(flags.isLead, false);
  assert.equal(flags.isQualified, true);
  assert.equal(flags.status, true);
  assert.equal(flags.lossReason, false);

  const oppCall = calls.find((c) => /whatsapp_opportunity_events/.test(c.text))!;
  assert.ok(oppCall, 'query de eventos deve rodar');
  // predicado humano NA coluna changed_by.
  assert.match(oppCall.text, /changed_by IS NOT NULL AND changed_by NOT IN \('ai', 'system', 'migration'\)/);
  // filtra os fields relevantes.
  assert.match(oppCall.text, /field IN \('qualification', 'status', 'loss_reason', 'tag_removed'\)/);
  // agregação por dimensão.
  assert.match(oppCall.text, /bool_or\(field = 'qualification'\)/);
  assert.match(oppCall.text, /bool_or\(field = 'status'\)/);
  assert.match(oppCall.text, /bool_or\(field = 'loss_reason'\)/);
  assert.deepEqual(oppCall.params, [55]);
});

// =============================================================================
// 5. tagsRemovedByHuman ⇐ tag_removed humanos (new_value)
// =============================================================================

test('computeSticky: tagsRemovedByHuman lista os nomes removidos por humano', async () => {
  const { client, calls } = fakeClient(route({ opp: oppRow({ tags_removed: ['VIP', 'urgente'] }) }));
  const flags = await computeSticky(client, { numberId: 1, identifier: 'c', opportunityId: 55 });
  assert.deepEqual(flags.tagsRemovedByHuman, ['VIP', 'urgente']);

  const oppCall = calls.find((c) => /whatsapp_opportunity_events/.test(c.text))!;
  // coleta new_value só das linhas tag_removed.
  assert.match(oppCall.text, /array_agg\(DISTINCT new_value\) FILTER \(WHERE field = 'tag_removed'/);
});

test('computeSticky: tags_removed NULL do driver → lista vazia (defensivo)', async () => {
  const { client } = fakeClient((text) => {
    if (/whatsapp_thread_meta_log/.test(text)) return [{ is_lead: false }];
    if (/whatsapp_opportunity_events/.test(text)) return [{ is_qualified: null, status: null, loss_reason: null, tags_removed: null }];
    return [];
  });
  const flags = await computeSticky(client, { numberId: 1, identifier: 'c', opportunityId: 55 });
  assert.deepEqual(flags, { isLead: false, isQualified: false, status: false, lossReason: false, tagsRemovedByHuman: [] });
});
