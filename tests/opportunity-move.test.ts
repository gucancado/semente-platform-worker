/**
 * tests/opportunity-move.test.ts
 *
 * Testes PUROS (sem Postgres nem env de servidor) da rota do DnD do board —
 * `moveOpportunity` (opportunities.ts) e o helper generalizado `applyThreadLead`.
 *
 * Cobre (Task C2.1):
 *  - Derivação coluna→patch (§5) × 5: cada coluna deriva o patch da opp (via
 *    kernel/UPDATE) e o alvo de thread corretos, partindo de uma opp FECHADA
 *    (perdido) pra revelar a reabertura no UPDATE.
 *  - No-op: mover pra coluna onde a opp JÁ está + thread já no valor → moved=false,
 *    sem UPDATE nem log de thread.
 *  - not_found quando o par (head) não existe.
 *  - applyThreadLead: generalização de applyThreadLeadTrue — aceita TRUE|NULL,
 *    upsert sempre + log SÓ em mudança; token literal (params do log estáveis);
 *    NUNCA parametriza FALSE por aqui.
 *
 * opportunities.ts só importa TIPOS de 'pg' + módulos puros (opportunity-core /
 * conversation-lock / loss-reasons / board), então não carrega o env do servidor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveOpportunity, applyThreadLead } from '../src/whatsapp/opportunities.js';

// ── client/pool fake compartilhado: grava toda query (text+params) ─────────────
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
// applyThreadLead — upsert sempre, log só em mudança, TRUE|NULL (nunca FALSE)
// =============================================================================

const isMetaUpsert = (t: string) => /INSERT INTO whatsapp_thread_meta\b/.test(t);
const isMetaLog = (t: string) => /INSERT INTO whatsapp_thread_meta_log/.test(t);

test('applyThreadLead(TRUE): sem row anterior → upsert TRUE + log null→true, changed=true', async () => {
  const { client, calls } = fakeClient(() => []); // SELECT is_lead vazio
  const changed = await applyThreadLead(client, { numberId: 1, identifier: 'c', changedBy: 'u1' }, true);
  assert.equal(changed, true);
  const upserts = calls.filter((c) => isMetaUpsert(c.text));
  const logs = calls.filter((c) => isMetaLog(c.text));
  assert.equal(upserts.length, 1);
  assert.match(upserts[0]!.text, /is_lead = TRUE/);
  assert.equal(logs.length, 1);
  // new_value 'true' é literal no SQL → params do log = [numberId, identifier, old_value, actor]
  assert.deepEqual(logs[0]!.params, [1, 'c', null, 'u1']);
});

test('applyThreadLead(TRUE): prev já TRUE → upsert TRUE mas NÃO loga (changed=false)', async () => {
  const { client, calls } = fakeClient((t) =>
    /SELECT is_lead FROM whatsapp_thread_meta/.test(t) ? [{ is_lead: true }] : []);
  const changed = await applyThreadLead(client, { numberId: 1, identifier: 'c', changedBy: 'u1' }, true);
  assert.equal(changed, false);
  assert.equal(calls.filter((c) => isMetaLog(c.text)).length, 0);
});

test('applyThreadLead(NULL): prev TRUE → upsert NULL + log true→null, changed=true', async () => {
  const { client, calls } = fakeClient((t) =>
    /SELECT is_lead FROM whatsapp_thread_meta/.test(t) ? [{ is_lead: true }] : []);
  const changed = await applyThreadLead(client, { numberId: 2, identifier: 'x', changedBy: 'u9' }, null);
  assert.equal(changed, true);
  const upserts = calls.filter((c) => isMetaUpsert(c.text));
  assert.equal(upserts.length, 1);
  assert.match(upserts[0]!.text, /is_lead = NULL/);
  const logs = calls.filter((c) => isMetaLog(c.text));
  assert.equal(logs.length, 1);
  // old_value 'true' vem por param; new_value NULL é literal → params = [num, id, old, actor]
  assert.deepEqual(logs[0]!.params, [2, 'x', 'true', 'u9']);
});

test('applyThreadLead(NULL): prev já NULL/ausente → upsert NULL sem log (changed=false)', async () => {
  const { client, calls } = fakeClient(() => []); // sem row → prev NULL
  const changed = await applyThreadLead(client, { numberId: 1, identifier: 'c', changedBy: 'u1' }, null);
  assert.equal(changed, false);
  assert.equal(calls.filter((c) => isMetaLog(c.text)).length, 0);
  assert.equal(calls.filter((c) => isMetaUpsert(c.text)).length, 1, 'upsert roda mesmo sem mudança (idempotente)');
});

// =============================================================================
// moveOpportunity — derivação coluna→patch (§5), a partir de uma opp FECHADA
// =============================================================================

// fakePoolForMove: head via pool.query; connect() devolve um client cujo OPP_SELECT
// devolve `currentRow`. `SELECT is_lead` reflete `threadIsLead` inicial e o valor
// upsertado depois (TRUE/NULL do token literal). Grava todas as queries do client.
function fakePoolForMove(currentRow: any, opts: { threadIsLead?: boolean | null } = {}) {
  const calls: { text: string; params: any[] }[] = [];
  let thread: boolean | null | 'absent' = 'threadIsLead' in opts ? (opts.threadIsLead ?? null) : 'absent';
  const head = { whatsapp_number_id: currentRow.whatsapp_number_id, identifier: currentRow.identifier };
  const client = {
    query(text: string, params: any[] = []) {
      calls.push({ text, params });
      if (/SELECT whatsapp_number_id, identifier FROM whatsapp_opportunities WHERE id/.test(text)) {
        return Promise.resolve({ rows: [head], rowCount: 1 });
      }
      if (/^SELECT o\.\*/.test(text)) return Promise.resolve({ rows: [currentRow], rowCount: 1 });
      if (/SELECT is_lead FROM whatsapp_thread_meta/.test(text)) {
        return Promise.resolve({ rows: thread === 'absent' ? [] : [{ is_lead: thread }], rowCount: 1 });
      }
      if (/INSERT INTO whatsapp_thread_meta\b/.test(text)) {
        thread = /is_lead = NULL/.test(text) ? null : true;
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release() {},
  };
  const pool = {
    query(text: string, params: any[] = []) {
      calls.push({ text, params });
      if (/SELECT whatsapp_number_id, identifier FROM whatsapp_opportunities WHERE id/.test(text)) {
        return Promise.resolve({ rows: [head], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    connect() { return Promise.resolve(client); },
  } as any;
  return { pool, calls };
}

// opp FECHADA (perdido, motivo lead_nao_respondeu, isQualified NULL), thread ausente.
const closedRow = () => ({
  id: 7, whatsapp_number_id: 9, identifier: '+5511',
  title: null, status: 'perdido', is_qualified: null, loss_reason: 'lead_nao_respondeu',
  created_at: new Date('2026-07-01T00:00:00.000Z'), updated_at: new Date('2026-07-02T00:00:00.000Z'),
  closed_at: new Date('2026-07-02T00:00:00.000Z'), created_by: 'u0', tags: [],
});

const updateCall = (calls: { text: string; params: any[] }[]) =>
  calls.find((c) => /UPDATE whatsapp_opportunities SET/.test(c.text));
const threadUpsertCall = (calls: { text: string; params: any[] }[]) =>
  calls.find((c) => /INSERT INTO whatsapp_thread_meta\b/.test(c.text));

test('move → novas_conversas: reabre (status em_andamento, is_qualified NULL, loss NULL) + thread NULL', async () => {
  const { pool, calls } = fakePoolForMove(closedRow());
  const res = await moveOpportunity(pool, 7, 'novas_conversas', null, 'u1');
  assert.equal(res.ok, true);
  const up = updateCall(calls)!;
  // UPDATE params: [id, status, is_qualified, qualification, title, loss_reason]
  assert.equal(up.params[1], 'em_andamento');
  assert.equal(up.params[2], null, 'is_qualified NULL');
  assert.equal(up.params[5], null, 'loss_reason limpo na reabertura');
  const th = threadUpsertCall(calls)!;
  assert.match(th.text, /is_lead = NULL/, 'thread vai pra NULL');
});

test('move → interessados: reabre + is_qualified NULL + thread TRUE (com log)', async () => {
  const { pool, calls } = fakePoolForMove(closedRow());
  const res = await moveOpportunity(pool, 7, 'interessados', null, 'u1');
  assert.equal(res.ok, true);
  const up = updateCall(calls)!;
  assert.equal(up.params[1], 'em_andamento');
  assert.equal(up.params[2], null, 'is_qualified NULL');
  const th = threadUpsertCall(calls)!;
  assert.match(th.text, /is_lead = TRUE/, 'thread vira lead');
  assert.equal(calls.filter((c) => isMetaLog(c.text)).length, 1, 'thread ausente→TRUE loga');
});

test('move → negociacoes: reabre + is_qualified TRUE + thread TRUE via kernel (sem write explícito)', async () => {
  const { pool, calls } = fakePoolForMove(closedRow());
  const res = await moveOpportunity(pool, 7, 'negociacoes', null, 'u1');
  assert.equal(res.ok, true);
  const up = updateCall(calls)!;
  assert.equal(up.params[1], 'em_andamento');
  assert.equal(up.params[2], true, 'is_qualified TRUE');
  // is_qualified TRUE cascateia set_true no kernel → exatamente 1 upsert de thread TRUE.
  const upserts = calls.filter((c) => isMetaUpsert(c.text));
  assert.equal(upserts.length, 1);
  assert.match(upserts[0]!.text, /is_lead = TRUE/);
});

test('move → ganhos: status ganho (kernel força qualificado+lead)', async () => {
  const { pool, calls } = fakePoolForMove(closedRow());
  const res = await moveOpportunity(pool, 7, 'ganhos', null, 'u1');
  assert.equal(res.ok, true);
  const up = updateCall(calls)!;
  assert.equal(up.params[1], 'ganho');
  assert.equal(up.params[2], true, 'ganho ⇒ is_qualified TRUE');
  assert.match(up.text, /closed_at = NOW\(\)/, 'fecha');
  const upserts = calls.filter((c) => isMetaUpsert(c.text));
  assert.equal(upserts.length, 1, 'ganho cascateia is_lead=TRUE');
  assert.match(upserts[0]!.text, /is_lead = TRUE/);
});

test('move → perdas: status perdido + loss_reason do modal, sem tocar a thread', async () => {
  const { pool, calls } = fakePoolForMove(closedRow());
  const res = await moveOpportunity(pool, 7, 'perdas', 'sem_orcamento', 'u1');
  assert.equal(res.ok, true);
  const up = updateCall(calls)!;
  assert.equal(up.params[1], 'perdido');
  assert.equal(up.params[5], 'sem_orcamento', 'novo motivo gravado');
  assert.equal(calls.some((c) => isMetaUpsert(c.text)), false, 'perda não escreve triagem');
});

// =============================================================================
// moveOpportunity — no-op e not_found
// =============================================================================

test('move no-op: opp já na coluna + thread no valor → moved=false, sem UPDATE nem log', async () => {
  // Opp já em novas_conversas (em_andamento, is_qualified NULL) e thread já NULL.
  const openRow = {
    id: 7, whatsapp_number_id: 9, identifier: '+5511', title: null,
    status: 'em_andamento', is_qualified: null, loss_reason: null,
    created_at: new Date(), updated_at: new Date(), closed_at: null, created_by: 'u0', tags: [],
  };
  const { pool, calls } = fakePoolForMove(openRow, { threadIsLead: null });
  const res = await moveOpportunity(pool, 7, 'novas_conversas', null, 'u1');
  assert.equal(res.ok, true);
  assert.equal((res as any).moved, false);
  assert.equal(updateCall(calls), undefined, 'nada muda na opp');
  assert.equal(calls.filter((c) => isMetaLog(c.text)).length, 0, 'thread já NULL não loga');
});

test('move: par inexistente (head vazio) → not_found sem abrir conexão', async () => {
  let connected = false;
  const pool = {
    query() { return Promise.resolve({ rows: [], rowCount: 0 }); },
    connect() { connected = true; return Promise.resolve({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }); },
  } as any;
  const res = await moveOpportunity(pool, 999, 'ganhos', null, 'u1');
  assert.deepEqual(res, { ok: false, error: 'not_found' });
  assert.equal(connected, false, 'head vazio → nem abre o lock');
});
