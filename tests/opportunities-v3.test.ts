/**
 * tests/opportunities-v3.test.ts
 *
 * Testes PUROS (sem Postgres nem env de servidor) do data layer v3 de oportunidades:
 *   - mapOpportunity: snake→camel com as colunas novas (is_qualified/loss_reason) e
 *     qualification derivada (com fallback pra coluna legada quando is_qualified some).
 *   - resolveIsQualifiedFilter: alias tri-state qualification↔isQualified do filtro.
 *   - countOpenOpportunities: SQL shape via client fake (só em_andamento do par).
 *   - countAnyOpportunities: idem, mas SEM filtro de status (qualquer opp do par) —
 *     usada pela re-checagem do poller (Fase B, skipIfAnyOpportunity).
 *   - applyThreadLeadTrue: side-effect da thread — upsert is_lead=TRUE sempre, log
 *     em whatsapp_thread_meta_log SÓ SE o valor anterior era diferente de TRUE
 *     (cross-task OBRIGATÓRIA: log incondicional travaria o sticky da IA num title-edit).
 *   - createOpportunityV3 com skipIfAnyOpportunity: a re-checagem "zero opps do par"
 *     roda DENTRO da tx, ANTES do INSERT (Fase B, Task B1); sem a flag, comportamento
 *     pré-existente intocado (nunca conta nada).
 *   - patchOpportunityGuarded / patchOpportunityV3 (Fase B, Task B2 fix round 1):
 *     o guard roda DENTRO do lock, depois do re-read, ANTES de qualquer escrita —
 *     guard false → conflict sem UPDATE/eventos; guard recebe o estado ATUAL
 *     relido (não um valor capturado antes do lock); guard true → fluxo idêntico
 *     ao patch sem guard; patchOpportunityV3 delega pra guarded com guard
 *     sempre-true (contrato pré-existente intocado, incl. not_found passthrough).
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
  countAnyOpportunities,
  applyThreadLeadTrue,
  createOpportunityV3,
  deleteOpportunityV3,
  patchOpportunityGuarded,
  patchOpportunityV3,
} from '../src/whatsapp/opportunities.js';
import { OppInvariantError } from '../src/whatsapp/opportunity-core.js';

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
// countAnyOpportunities — SQL shape (client fake), SEM filtro de status
// =============================================================================

test('countAnyOpportunities: conta QUALQUER status do par (sem filtro em status) e devolve inteiro', async () => {
  const { client, calls } = fakeClient(() => [{ n: 4 }]);
  const n = await countAnyOpportunities(client, 9, '+5511');
  assert.equal(n, 4);
  const first = calls[0]!;
  assert.match(first.text, /FROM whatsapp_opportunities/);
  assert.doesNotMatch(first.text, /status\s*=/, 'não filtra por status — conta em_andamento/ganho/perdido');
  assert.match(first.text, /whatsapp_number_id = \$1 AND identifier = \$2/);
  assert.deepEqual(first.params, [9, '+5511']);
});

test('countAnyOpportunities: sem rows → 0', async () => {
  const { client } = fakeClient(() => []);
  assert.equal(await countAnyOpportunities(client, 1, 'c'), 0);
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

// =============================================================================
// createOpportunityV3 — isQualified=false é rejeitado ANTES de qualquer escrita
// =============================================================================

test('createOpportunityV3: isQualified=false lança invalid_value sem tocar o banco', async () => {
  let connected = false;
  const calls: { text: string; params: any[] }[] = [];
  const fakePool = {
    connect() {
      connected = true;
      return Promise.resolve({
        query(text: string, params: any[] = []) { calls.push({ text, params }); return Promise.resolve({ rows: [], rowCount: 0 }); },
        release() {},
      });
    },
  } as any;

  await assert.rejects(
    () => createOpportunityV3(fakePool, { numberId: 1, workspaceId: 'ws', identifier: 'c', isQualified: false, createdBy: 'u1' }),
    (err) => err instanceof OppInvariantError && err.code === 'invalid_value',
  );
  assert.equal(connected, false, 'não deve nem abrir conexão (throw antes do lock)');
  assert.equal(calls.length, 0, 'nenhuma query — nenhum INSERT');
});

// =============================================================================
// createOpportunityV3 com skipIfAnyOpportunity — re-checagem atômica (Fase B)
// =============================================================================

// fakePoolForCreate: connect() devolve um client cujo SELECT COUNT responde
// `anyCount`; INSERT devolve id fixo; o SELECT final (OPP_SELECT) devolve uma row
// mínima válida. Grava a sequência de queries do client (BEGIN/lock/count/INSERT/...).
function fakePoolForCreate(opts: { anyCount: number }) {
  const calls: { text: string; params: any[] }[] = [];
  let connected = false;
  const client = {
    query(text: string, params: any[] = []) {
      calls.push({ text, params });
      if (/SELECT COUNT\(\*\)::int AS n FROM whatsapp_opportunities/.test(text)) {
        return Promise.resolve({ rows: [{ n: opts.anyCount }], rowCount: 1 });
      }
      if (/INSERT INTO whatsapp_opportunities/.test(text)) {
        return Promise.resolve({ rows: [{ id: 42 }], rowCount: 1 });
      }
      if (/^SELECT o\.\*/.test(text)) {
        return Promise.resolve({
          rows: [{
            id: 42, identifier: 'c', title: null, status: 'em_andamento',
            is_qualified: null, loss_reason: null, created_at: new Date(), updated_at: new Date(),
            closed_at: null, created_by: 'system', tags: [],
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 }); // BEGIN / lock / COMMIT
    },
    release() {},
  };
  const pool = { connect() { connected = true; return Promise.resolve(client); } } as any;
  return { pool, calls, wasConnected: () => connected };
}

test('createOpportunityV3 skipIfAnyOpportunity: par já tem opportunity (qualquer status) → skip sem INSERT', async () => {
  const { pool, calls } = fakePoolForCreate({ anyCount: 1 });
  const result = await createOpportunityV3(pool, {
    numberId: 9, workspaceId: 'ws', identifier: 'c', createdBy: 'system', skipIfAnyOpportunity: true,
  });
  assert.deepEqual(result, { skipped: true });
  const texts = calls.map((c) => c.text);
  assert.equal(texts.some((t) => /INSERT INTO whatsapp_opportunities/.test(t)), false,
    'não insere quando já existe opp do par (qualquer status)');
  const lockIdx = texts.findIndex((t) => /pg_advisory_xact_lock/.test(t));
  const countIdx = texts.findIndex((t) => /SELECT COUNT\(\*\)::int AS n FROM whatsapp_opportunities/.test(t));
  assert.ok(lockIdx >= 0 && lockIdx < countIdx, 'a contagem roda DEPOIS do lock, dentro da mesma tx');
});

test('createOpportunityV3 skipIfAnyOpportunity: par sem opportunity (anyCount=0) → segue e insere normalmente', async () => {
  const { pool, calls } = fakePoolForCreate({ anyCount: 0 });
  const result = await createOpportunityV3(pool, {
    numberId: 9, workspaceId: 'ws', identifier: 'c', createdBy: 'system', skipIfAnyOpportunity: true,
  });
  assert.ok(result, 'deve devolver a opportunity criada, não null');
  assert.equal('skipped' in result, false, 'não deve ser o retorno de skip');
  assert.equal((result as { id: number }).id, 42);
  assert.equal(calls.some((c) => /INSERT INTO whatsapp_opportunities/.test(c.text)), true);
});

test('createOpportunityV3 SEM skipIfAnyOpportunity: nunca conta nada, sempre insere (comportamento pré-existente intocado)', async () => {
  const { pool, calls } = fakePoolForCreate({ anyCount: 5 }); // mesmo com opps existentes no fake
  const result = await createOpportunityV3(pool, { numberId: 9, workspaceId: 'ws', identifier: 'c', createdBy: 'u1' });
  assert.ok(result && !('skipped' in result));
  assert.equal(calls.some((c) => /SELECT COUNT\(\*\)::int AS n FROM whatsapp_opportunities/.test(c.text)), false,
    'sem a flag (uso por rota humana), a re-checagem de contagem não roda');
  assert.equal(calls.some((c) => /INSERT INTO whatsapp_opportunities/.test(c.text)), true);
});

// =============================================================================
// deleteOpportunityV3 — DELETE sob o lock da conversa (§4.11), re-lê dentro da tx
// =============================================================================

// fakePool: pool.query resolve a descoberta do par (head); connect() devolve um
// client cujo `SELECT 1 ... WHERE id` responde conforme `rereadExists`. Grava a
// sequência de queries do client (BEGIN/lock/re-read/DELETE/COMMIT).
function fakePoolForDelete(opts: {
  headRow: { whatsapp_number_id: number; identifier: string } | null; rereadExists: boolean;
}) {
  const clientCalls: { text: string; params: any[] }[] = [];
  let connected = false;
  const client = {
    query(text: string, params: any[] = []) {
      clientCalls.push({ text, params });
      if (/SELECT 1 FROM whatsapp_opportunities WHERE id/.test(text)) {
        return Promise.resolve({ rows: opts.rereadExists ? [{ '?column?': 1 }] : [], rowCount: opts.rereadExists ? 1 : 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release() {},
  };
  const pool = {
    query(text: string, _params: any[] = []) {
      if (/SELECT whatsapp_number_id, identifier FROM whatsapp_opportunities WHERE id/.test(text)) {
        return Promise.resolve({ rows: opts.headRow ? [opts.headRow] : [], rowCount: opts.headRow ? 1 : 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    connect() { connected = true; return Promise.resolve(client); },
  } as any;
  return { pool, clientCalls, wasConnected: () => connected };
}

const isDelete = (t: string) => /DELETE FROM whatsapp_opportunities WHERE id/.test(t);
const isLock = (t: string) => /pg_advisory_xact_lock/.test(t);

test('deleteOpportunityV3: opp inexistente → not_found sem abrir conexão (nem lock)', async () => {
  const { pool, wasConnected } = fakePoolForDelete({ headRow: null, rereadExists: false });
  const result = await deleteOpportunityV3(pool, 7);
  assert.deepEqual(result, { ok: false, error: 'not_found' });
  assert.equal(wasConnected(), false, 'não abre conexão quando o head já não acha a opp');
});

test('deleteOpportunityV3: opp presente → lock, re-lê e DELETE (nessa ordem), ok:true', async () => {
  const { pool, clientCalls } = fakePoolForDelete({ headRow: { whatsapp_number_id: 9, identifier: '+5511' }, rereadExists: true });
  const result = await deleteOpportunityV3(pool, 7);
  assert.deepEqual(result, { ok: true });
  const texts = clientCalls.map((c) => c.text);
  assert.equal(texts[0], 'BEGIN');
  assert.equal(texts.at(-1), 'COMMIT');
  const lockIdx = texts.findIndex(isLock);
  const rereadIdx = texts.findIndex((t) => /SELECT 1 FROM whatsapp_opportunities WHERE id/.test(t));
  const delIdx = texts.findIndex(isDelete);
  assert.ok(lockIdx >= 0 && lockIdx < rereadIdx && rereadIdx < delIdx, 'lock → re-read → DELETE');
  // a chave do lock é `${numberId}:${identifier}` (mesma de conversation-lock.ts)
  assert.deepEqual(clientCalls[lockIdx]!.params, ['9:+5511']);
});

test('deleteOpportunityV3: row sumiu entre a descoberta e o lock → not_found, sem DELETE', async () => {
  const { pool, clientCalls } = fakePoolForDelete({ headRow: { whatsapp_number_id: 9, identifier: 'c' }, rereadExists: false });
  const result = await deleteOpportunityV3(pool, 7);
  assert.deepEqual(result, { ok: false, error: 'not_found' });
  assert.equal(clientCalls.filter((c) => isDelete(c.text)).length, 0, 'não deleta se a re-leitura não achou a row');
});

// =============================================================================
// patchOpportunityGuarded / patchOpportunityV3 — guard sob o lock (Fase B,
// Task B2 fix round 1): fecha a janela entre um SELECT de candidatos feito
// FORA do lock (jobs automáticos) e o momento em que o patch toma o lock.
// =============================================================================

const baseOppRow = {
  id: 1, identifier: 'c', title: null, status: 'em_andamento',
  is_qualified: null, loss_reason: null, created_at: new Date(), updated_at: new Date(),
  closed_at: null, created_by: 'system', tags: [], whatsapp_number_id: 9,
};

// fakePoolForPatch: pool.query resolve a descoberta do par (head, default derivado
// de currentRow); connect() devolve um client cujo `SELECT o.*` SEMPRE devolve
// `currentRow` (antes E depois da escrita — suficiente pra testar o guard e o
// passthrough de erro; os testes end-to-end de mutação real já vivem em
// tests/auto-loss.test.ts e no .db.test.ts).
function fakePoolForPatch(opts: {
  headRow?: { whatsapp_number_id: number; identifier: string } | null;
  currentRow: any;
}) {
  const clientCalls: { text: string; params: any[] }[] = [];
  const client = {
    query(text: string, params: any[] = []) {
      clientCalls.push({ text, params });
      if (/^SELECT o\.\*/.test(text)) return Promise.resolve({ rows: [opts.currentRow], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 }); // BEGIN / lock / UPDATE / INSERT events / COMMIT
    },
    release() {},
  };
  const pool = {
    query(text: string) {
      if (/SELECT whatsapp_number_id, identifier FROM whatsapp_opportunities WHERE id/.test(text)) {
        const head = opts.headRow === undefined
          ? { whatsapp_number_id: opts.currentRow.whatsapp_number_id, identifier: opts.currentRow.identifier }
          : opts.headRow;
        return Promise.resolve({ rows: head ? [head] : [], rowCount: head ? 1 : 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    connect() { return Promise.resolve(client); },
  } as any;
  return { pool, clientCalls };
}

test('patchOpportunityGuarded: guard false → conflict, ZERO escrita (nem UPDATE nem eventos)', async () => {
  const { pool, clientCalls } = fakePoolForPatch({ currentRow: baseOppRow });
  const result = await patchOpportunityGuarded(pool, 1, { status: 'perdido', lossReason: 'x' }, 'system', async () => false);
  assert.deepEqual(result, { ok: false, error: 'conflict' });
  assert.equal(clientCalls.some((c) => /UPDATE whatsapp_opportunities SET/.test(c.text)), false,
    'guard barra ANTES do UPDATE');
  assert.equal(clientCalls.some((c) => /INSERT INTO whatsapp_opportunity_events/.test(c.text)), false);
  // Nada escrito → o COMMIT final é um no-op (equivalente a rollback no efeito).
  assert.equal(clientCalls.at(-1)!.text, 'COMMIT');
});

test('patchOpportunityGuarded: guard recebe o estado ATUAL relido dentro do lock, não um valor pré-lock', async () => {
  const { pool } = fakePoolForPatch({ currentRow: { ...baseOppRow, status: 'ganho', is_qualified: true } });
  let seen: { status: string; isQualified: boolean | null } | null = null;
  await patchOpportunityGuarded(pool, 1, { title: 'novo título' }, 'system', async (_client, current) => {
    seen = current;
    return true;
  });
  assert.equal(seen?.status, 'ganho');
  assert.equal(seen?.isQualified, true);
});

test('patchOpportunityGuarded: guard true → segue o fluxo normal (UPDATE + eventos), igual a um patch sem guard', async () => {
  const { pool, clientCalls } = fakePoolForPatch({ currentRow: baseOppRow });
  const result = await patchOpportunityGuarded(pool, 1, { status: 'perdido', lossReason: 'lead_nao_respondeu' }, 'system', async () => true);
  assert.equal(result.ok, true);
  assert.ok(clientCalls.some((c) => /UPDATE whatsapp_opportunities SET/.test(c.text)));
  const eventCalls = clientCalls.filter((c) => /INSERT INTO whatsapp_opportunity_events/.test(c.text));
  assert.equal(eventCalls.length, 2, 'status + loss_reason');
});

test('patchOpportunityGuarded: opp não encontrada no head → not_found, guard NUNCA é chamado (nem lock)', async () => {
  const { pool } = fakePoolForPatch({ headRow: null, currentRow: baseOppRow });
  let guardCalled = false;
  const result = await patchOpportunityGuarded(pool, 999, { status: 'perdido', lossReason: 'x' }, 'system', async () => {
    guardCalled = true;
    return true;
  });
  assert.deepEqual(result, { ok: false, error: 'not_found' });
  assert.equal(guardCalled, false, 'sem row no head, nem chega a abrir o lock/re-read');
});

test('patchOpportunityV3: delega pra patchOpportunityGuarded com guard sempre-true (comportamento idêntico ao pré-fix)', async () => {
  const { pool, clientCalls } = fakePoolForPatch({ currentRow: baseOppRow });
  const result = await patchOpportunityV3(pool, 1, { status: 'perdido', lossReason: 'lead_nao_respondeu' }, 'u1');
  assert.equal(result.ok, true);
  assert.ok(clientCalls.some((c) => /UPDATE whatsapp_opportunities SET/.test(c.text)));
});

test('patchOpportunityV3: not_found segue passthrough (o guard sempre-true não muda o contrato pré-existente)', async () => {
  const { pool } = fakePoolForPatch({ headRow: null, currentRow: baseOppRow });
  const result = await patchOpportunityV3(pool, 999, { status: 'perdido', lossReason: 'x' }, 'u1');
  assert.deepEqual(result, { ok: false, error: 'not_found' });
});
