// tests/lead-triage-v3.test.ts
//
// PURE (DB-free) tests for Task 6 — triagem tri-state + cascata não-lead.
// Run: node --import tsx --test tests/lead-triage-v3.test.ts
//
// Cobre:
//   1. Parse tri-state do body ('indefinido' → is_lead NULL; inválido → 400).
//   2. Decisão de log em whatsapp_thread_meta_log (só em mudança efetiva):
//      TRUE→TRUE não loga; NULL→TRUE loga; FALSE→NULL loga.
//   3. Cascata não-lead: opp 'ganho' → LeadCascadeGanhoError com identifier,
//      ANTES de qualquer escrita (upsert/log não acontecem).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { resolveLeadStatus, statusToIsLead } from '../src/whatsapp/lead-qualify.js';
import { applyLeadUpdate, LeadCascadeGanhoError } from '../src/whatsapp/thread-meta.js';
import { registerWriteRoutes } from '../src/whatsapp/write-routes.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Parse tri-state
// ─────────────────────────────────────────────────────────────────────────────

test('resolveLeadStatus: aceita indefinido além de lead/not_lead', () => {
  assert.deepEqual(resolveLeadStatus('lead'), { status: 'lead' });
  assert.deepEqual(resolveLeadStatus('not_lead'), { status: 'not_lead' });
  assert.deepEqual(resolveLeadStatus('indefinido'), { status: 'indefinido' });
});

test('resolveLeadStatus: valor inválido continua erro', () => {
  const r = resolveLeadStatus('maybe');
  assert.ok('error' in r);
  assert.match(r.error, /status must be/);
});

test('statusToIsLead: indefinido → null; lead → true; not_lead → false', () => {
  assert.equal(statusToIsLead('lead'), true);
  assert.equal(statusToIsLead('not_lead'), false);
  assert.equal(statusToIsLead('indefinido'), null);
});

const TOKEN = 'test-panel';
const HEADERS = { 'x-panel-token': TOKEN, 'x-acting-user': 'user-1' };
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };

// Pool que rejeita qualquer query — prova que a validação de status roda antes de tocar o DB.
const PANIC_POOL = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'query' || prop === 'connect') return () => Promise.reject(new Error('DB should not be reached'));
    return undefined;
  },
}) as any;

test('rota single: status inválido → 400 sem tocar o DB', async () => {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: TOKEN, authz: passAuthz });
  const res = await app.inject({
    method: 'POST', url: '/whatsapp/threads/thread-1/lead', headers: HEADERS,
    payload: { number_id: 1, status: 'talvez' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /status must be/);
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Decisão de log — applyLeadUpdate com client falso capturando queries
// ─────────────────────────────────────────────────────────────────────────────

/** Client falso: SELECT is_lead devolve prevRows; ganho devolve ganhoRows; resto []. */
function makeClient(prevRows: any[], ganhoRows: any[] = []) {
  const calls: { sql: string; params: unknown[] | undefined }[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql.includes('SELECT is_lead') && sql.includes('whatsapp_thread_meta')) return { rows: prevRows };
      if (sql.includes('whatsapp_opportunities') && sql.includes("'ganho'")) return { rows: ganhoRows };
      return { rows: [] };
    },
  } as any;
  return { calls, client };
}
const logCall = (calls: { sql: string }[]) => calls.find((c) => c.sql.includes('whatsapp_thread_meta_log'));

test('log: TRUE → TRUE não gera row em thread_meta_log', async () => {
  const { calls, client } = makeClient([{ is_lead: true }]);
  await applyLeadUpdate(client, { numberId: 1, identifier: 't', isLead: true, updatedBy: 'u' });
  assert.equal(logCall(calls), undefined, 'valor efetivo não mudou → não loga');
});

test('log: NULL (sem row) → TRUE gera log com old=null new=true', async () => {
  const { calls, client } = makeClient([]);
  await applyLeadUpdate(client, { numberId: 1, identifier: 't', isLead: true, updatedBy: 'u' });
  const log = logCall(calls);
  assert.ok(log, 'mudou → loga');
  assert.equal(log!.params?.[3], null);
  assert.equal(log!.params?.[4], 'true');
});

test('log: FALSE → NULL (indefinido) gera log com old=false new=null', async () => {
  const { calls, client } = makeClient([{ is_lead: false }]);
  await applyLeadUpdate(client, { numberId: 1, identifier: 't', isLead: null, updatedBy: 'u' });
  const log = logCall(calls);
  assert.ok(log, 'FALSE→NULL mudou → loga');
  assert.equal(log!.params?.[3], 'false');
  assert.equal(log!.params?.[4], null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Cascata não-lead — opp ganha bloqueia
// ─────────────────────────────────────────────────────────────────────────────

test('cascata: opp status=ganho → LeadCascadeGanhoError(identifier), sem upsert/log', async () => {
  const { calls, client } = makeClient([{ is_lead: true }], [{ '?column?': 1 }]);
  await assert.rejects(
    () => applyLeadUpdate(client, { numberId: 7, identifier: 'lead-x', isLead: false, updatedBy: 'u' }),
    (err: unknown) => {
      assert.ok(err instanceof LeadCascadeGanhoError);
      assert.equal((err as LeadCascadeGanhoError).identifier, 'lead-x');
      return true;
    },
  );
  // Nada é gravado: a exceção sobe antes do upsert e do log.
  assert.equal(calls.find((c) => c.sql.includes('ON CONFLICT')), undefined, 'não faz upsert do thread_meta');
  assert.equal(logCall(calls), undefined, 'não loga is_lead');
});

test('cascata: sem opp ganha, FALSE segue e loga a mudança', async () => {
  const { calls, client } = makeClient([{ is_lead: true }], []);
  await applyLeadUpdate(client, { numberId: 7, identifier: 'lead-y', isLead: false, updatedBy: 'u' });
  const log = logCall(calls);
  assert.ok(log, 'TRUE→FALSE muda → loga');
  assert.equal(log!.params?.[3], 'true');
  assert.equal(log!.params?.[4], 'false');
});
