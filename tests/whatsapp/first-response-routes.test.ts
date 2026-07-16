/**
 * tests/whatsapp/first-response-routes.test.ts
 *
 * DB-FREE gate/contract tests para GET /whatsapp/first-response.
 * Espelha o harness de timeseries-routes.test.ts: injeta authz fake + pool
 * fake/panic e verifica status/body SEM Postgres nem chamada ao Bloquim.
 *
 * Casos:
 *   fr-1: actor ausente → 400, gate não chamado
 *   fr-2: workspace_id ausente → 400, sem DB
 *   fr-3: number_id não-numérico → 400, gate não alcançado
 *   fr-4: FORBIDDEN → 403, DB NÃO chamado (ordem gateMember-antes-do-DB)
 *   fr-5: MISCONFIGURED → 500
 *   fr-6: number_id ausente → gate roda mesmo assim → 403
 *   fr-7: since/until ausentes → default de janela de 30 dias (since); until aberto
 *   fr-8: envelope whatsapp_v1 + eco de window/kind, payload agregado (sem identifier)
 *   fr-9: kind inválido → default 'dm'; kind repassado ao getFirstResponse
 *   fr-10: number_id repassado como number (não string) ao getFirstResponse
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthzError } from '../../src/whatsapp/authz.js';
import { registerReadRoutes } from '../../src/whatsapp/read-routes.js';
import type { RouteAuthz } from '../../src/whatsapp/route-authz.js';

// Pool que explode se QUALQUER query for executada.
const PANIC_POOL = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'query') {
      return () => Promise.reject(new Error('DB should not be called before gate resolves'));
    }
    return undefined;
  },
}) as any;

function makeMemberForbidden(): RouteAuthz & { memberCalls: number } {
  return {
    memberCalls: 0,
    async assertMember() { this.memberCalls++; throw new AuthzError('forbidden', 'FORBIDDEN'); },
    async assertAdmin() { throw new AuthzError('forbidden', 'FORBIDDEN'); },
  };
}
function makeMemberMisconfigured(): RouteAuthz {
  return {
    async assertMember() { throw new AuthzError('misc', 'MISCONFIGURED'); },
    async assertAdmin() { throw new AuthzError('misc', 'MISCONFIGURED'); },
  };
}
function makeMemberAllowed(): RouteAuthz {
  return { async assertMember() { /* allow */ }, async assertAdmin() { /* allow */ } };
}

// Stub pool: grava as queries e devolve uma linha "vazia" (agregado zerado).
function makeStubPool() {
  const calls: { text: string; params: unknown[] }[] = [];
  const pool = {
    query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return Promise.resolve({ rows: [{ answered: 0, unanswered: 0, avg_minutes: null, median_minutes: null, p90_minutes: null }], rowCount: 1 });
    },
  } as any;
  return { pool, calls };
}

const PANEL_TOKEN = 'test-panel';
const PANEL_HEADERS = { 'x-panel-token': PANEL_TOKEN };
const ACTOR_HEADERS = { 'x-panel-token': PANEL_TOKEN, 'x-acting-user': 'user-abc' };
const URL = '/whatsapp/first-response';

function buildApp(opts: { pool: any; authz: RouteAuthz; logAccess?: (...a: any[]) => void }) {
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: opts.pool, panelToken: PANEL_TOKEN, authz: opts.authz, logAccess: opts.logAccess ?? (() => {}) });
  return app;
}

/** Coletor de logAccess — o stub default descarta e não prenderia a `action`. */
function makeLogCollector() {
  const entries: any[] = [];
  return { entries, logAccess: (_pool: any, e: any) => { entries.push(e); } };
}

// A query do getFirstResponse é a única que roda nesta rota (logAccess é stubbed).
const findFirstResponseCall = (calls: { text: string }[]) => calls.find(c => /FROM resp r/.test(c.text));

// ── gate ──────────────────────────────────────────────────────────────────────

test('fr-1: actor ausente → 400, gate não chamado', async () => {
  const spy = makeMemberForbidden();
  const app = buildApp({ pool: PANIC_POOL, authz: spy });
  const res = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1`, headers: PANEL_HEADERS });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'x-acting-user required');
  assert.equal(spy.memberCalls, 0);
  await app.close();
});

test('fr-2: workspace_id ausente → 400, sem DB', async () => {
  const spy = makeMemberForbidden();
  const app = buildApp({ pool: PANIC_POOL, authz: spy });
  const res = await app.inject({ method: 'GET', url: URL, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'workspace_id required');
  assert.equal(spy.memberCalls, 0);
  await app.close();
});

test('fr-3: number_id não-numérico → 400, gate não alcançado', async () => {
  const spy = makeMemberForbidden();
  const app = buildApp({ pool: PANIC_POOL, authz: spy });
  const res = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1&number_id=abc`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'number_id must be numeric');
  assert.equal(spy.memberCalls, 0);
  await app.close();
});

// O caso central da spec: o gate roda ANTES de qualquer toque no banco.
// PANIC_POOL garante que um DB call vazaria como 500, não como 403.
test('fr-4: FORBIDDEN → 403 e o DB NÃO é chamado', async () => {
  const spy = makeMemberForbidden();
  const app = buildApp({ pool: PANIC_POOL, authz: spy });
  const res = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1&number_id=1`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(spy.memberCalls, 1, 'assertMember deve ser chamado exatamente uma vez');
  await app.close();
});

test('fr-5: MISCONFIGURED → 500', async () => {
  const app = buildApp({ pool: PANIC_POOL, authz: makeMemberMisconfigured() });
  const res = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, 'authz_misconfigured');
  await app.close();
});

test('fr-6: number_id ausente → gate roda mesmo assim → 403', async () => {
  const spy = makeMemberForbidden();
  const app = buildApp({ pool: PANIC_POOL, authz: spy });
  const res = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 403);
  assert.equal(spy.memberCalls, 1, 'gate deve ser alcançado mesmo sem number_id');
  await app.close();
});

// ── defaults / envelope / repasse ─────────────────────────────────────────────

test('fr-7: since/until ausentes → default de janela de 30 dias (since); until aberto (null)', async () => {
  const { pool, calls } = makeStubPool();
  const app = buildApp({ pool, authz: makeMemberAllowed() });
  const res = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1`, headers: ACTOR_HEADERS });

  assert.equal(res.statusCode, 200);
  const call = findFirstResponseCall(calls);
  assert.ok(call, 'a query de first-response deve ter rodado');
  // $3=since, $4=until
  const spanMs = Date.now() - Date.parse(String(call!.params[2]));
  const drift = Math.abs(spanMs - 30 * 24 * 60 * 60 * 1000);
  assert.ok(drift < 5_000, `since default deve ser ~30d atrás, veio drift=${drift}ms`);
  assert.equal(call!.params[3], null, 'until ausente → bound aberto (null), não "agora"');
  const body = res.json();
  assert.equal(body.window.since, call!.params[2]);
  assert.equal(body.window.until, null);
  await app.close();
});

test('fr-8: envelope whatsapp_v1 + eco de window/kind, payload agregado sem identifier', async () => {
  const { pool } = makeStubPool();
  const app = buildApp({ pool, authz: makeMemberAllowed() });
  const res = await app.inject({
    method: 'GET',
    url: `${URL}?workspace_id=ws-1&since=2026-06-01T00:00:00Z&until=2026-06-30T00:00:00Z`,
    headers: ACTOR_HEADERS,
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schema, 'whatsapp_v1');
  assert.equal(body.context.workspaceId, 'ws-1');
  assert.equal(body.kind, 'dm', 'default kind = dm');
  assert.deepEqual(body.window, { since: '2026-06-01T00:00:00Z', until: '2026-06-30T00:00:00Z' });
  assert.equal(body.answered, 0);
  assert.equal(body.unanswered, 0);
  assert.equal(body.avgMinutes, null);
  assert.equal(body.medianMinutes, null);
  assert.equal(body.p90Minutes, null);
  // Payload agregado: nada de identifier/texto de conversa vazando no envelope.
  assert.ok(!('identifier' in body), 'envelope não deve expor identifier');
  await app.close();
});

test('fr-9: kind inválido → default "dm"; kind válido é repassado ao getFirstResponse', async () => {
  const { pool, calls } = makeStubPool();
  const app = buildApp({ pool, authz: makeMemberAllowed() });

  const resInvalid = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1&kind=xpto`, headers: ACTOR_HEADERS });
  assert.equal(resInvalid.json().kind, 'dm', 'kind inválido → default dm');

  const callsBeforeGroup = calls.length;
  const resGroup = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1&kind=group`, headers: ACTOR_HEADERS });
  assert.equal(resGroup.statusCode, 200);
  assert.equal(resGroup.json().kind, 'group');
  const call = findFirstResponseCall(calls.slice(callsBeforeGroup));
  assert.ok(call);
  assert.equal(call!.params[4], 'group', '$5=kind repassado à query');
  await app.close();
});

test('fr-10: number_id repassado como number (não string) ao getFirstResponse', async () => {
  const { pool, calls } = makeStubPool();
  const app = buildApp({ pool, authz: makeMemberAllowed() });
  const res = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1&number_id=7`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 200);
  const call = findFirstResponseCall(calls);
  assert.ok(call);
  assert.equal(call!.params[0], 'ws-1'); // $1 workspace
  assert.equal(call!.params[1], 7);      // $2 number_id — number, não "7"
  assert.strictEqual(typeof call!.params[1], 'number');
  await app.close();
});

// `Number('') === 0`, NÃO NaN: um guard que só testa isNaN deixa `?number_id=`
// passar e manda `whatsapp_number_id = 0` pro SQL, que não casa nada → 200 com
// agregado ZERADO em vez do agregado do workspace, em silêncio. `?number_id=%20%20`
// (whitespace) é o mesmo caso. Ambos têm que virar $2=null (sem filtro por número).
test('fr-11: number_id VAZIO/whitespace → $2=null (agregado do workspace), não 0', async () => {
  for (const raw of ['', '%20%20']) {
    const { pool, calls } = makeStubPool();
    const app = buildApp({ pool, authz: makeMemberAllowed() });
    const res = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1&number_id=${raw}`, headers: ACTOR_HEADERS });
    assert.equal(res.statusCode, 200, `number_id=${JSON.stringify(raw)} deve seguir como agregado do workspace`);
    const call = findFirstResponseCall(calls);
    assert.ok(call, 'a query deve ter rodado');
    assert.equal(call!.params[1], null, `number_id=${JSON.stringify(raw)} → $2 deve ser null, não 0`);
    await app.close();
  }
});

// A spec exige `action: 'first_response'` no logAccess; o stub `() => {}` dos
// outros casos descarta a chamada e não prenderia a ação nem o numberId.
test('fr-12: logAccess registra action="first_response" com o numberId normalizado', async () => {
  const { pool } = makeStubPool();
  const log = makeLogCollector();
  const app = buildApp({ pool, authz: makeMemberAllowed(), logAccess: log.logAccess });

  await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1&number_id=7`, headers: ACTOR_HEADERS });
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].action, 'first_response');
  assert.equal(log.entries[0].workspaceId, 'ws-1');
  assert.equal(log.entries[0].actor, 'user-abc');
  assert.equal(log.entries[0].numberId, 7);

  // number_id vazio → numberId do log é null (não 0).
  await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1&number_id=`, headers: ACTOR_HEADERS });
  assert.equal(log.entries[1].numberId, null, 'number_id vazio → log com numberId null, não 0');
  await app.close();
});
