/**
 * tests/whatsapp/timeseries-routes.test.ts
 *
 * DB-FREE gate/contract tests para GET /whatsapp/stats/timeseries.
 * Espelha o harness de stats-routes.test.ts: injeta authz fake + pool fake/panic
 * e verifica status/body SEM Postgres nem chamada ao Bloquim.
 *
 * Casos:
 *   ts-1: actor ausente → 400, gate não chamado
 *   ts-2: workspace_id ausente → 400, sem DB
 *   ts-3: number_id não-numérico → 400, sem DB
 *   ts-4: FORBIDDEN → 403, DB NÃO chamado (ordem gateMember-antes-do-DB)
 *   ts-5: MISCONFIGURED → 500
 *   ts-6: number_id ausente → gate roda mesmo assim → 403
 *   ts-7/ts-8: period_basis / bucket inválidos → 400, gate não chamado
 *   ts-9: since/until invertidos → 400
 *   ts-10: teto de buckets (off-by-one: span de 200 dias emitiria 201) → 400
 *   ts-11: janela dentro do teto → 200 (passa da guarda)
 *   ts-12: default de 30 dias quando since/until ausentes
 *   ts-13: envelope whatsapp_v1 + eco de bucket/periodBasis/window
 *   ts-14: kind/bucket/period_basis repassados ao getTimeseries
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

// Stub pool: grava as queries e devolve linhas vazias.
function makeStubPool() {
  const calls: { text: string; params: unknown[] }[] = [];
  const pool = {
    query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return Promise.resolve({ rows: [] as any[], rowCount: 0 });
    },
  } as any;
  return { pool, calls };
}

const PANEL_TOKEN = 'test-panel';
const PANEL_HEADERS = { 'x-panel-token': PANEL_TOKEN };
const ACTOR_HEADERS = { 'x-panel-token': PANEL_TOKEN, 'x-acting-user': 'user-abc' };
const URL = '/whatsapp/stats/timeseries';

function buildApp(opts: { pool: any; authz: RouteAuthz }) {
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: opts.pool, panelToken: PANEL_TOKEN, authz: opts.authz, logAccess: () => {} });
  return app;
}

// A query do getTimeseries é a única que roda nesta rota (logAccess é stubbed).
const findTimeseriesCall = (calls: { text: string }[]) => calls.find(c => /FROM buckets b/.test(c.text));

// ── gate ──────────────────────────────────────────────────────────────────────

test('ts-1: actor ausente → 400, gate não chamado', async () => {
  const spy = makeMemberForbidden();
  const app = buildApp({ pool: PANIC_POOL, authz: spy });
  const res = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1`, headers: PANEL_HEADERS });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'x-acting-user required');
  assert.equal(spy.memberCalls, 0);
  await app.close();
});

test('ts-2: workspace_id ausente → 400, sem DB', async () => {
  const spy = makeMemberForbidden();
  const app = buildApp({ pool: PANIC_POOL, authz: spy });
  const res = await app.inject({ method: 'GET', url: URL, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'workspace_id required');
  assert.equal(spy.memberCalls, 0);
  await app.close();
});

test('ts-3: number_id não-numérico → 400, gate não alcançado', async () => {
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
test('ts-4: FORBIDDEN → 403 e o DB NÃO é chamado', async () => {
  const spy = makeMemberForbidden();
  const app = buildApp({ pool: PANIC_POOL, authz: spy });
  const res = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1&number_id=1`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.equal(spy.memberCalls, 1, 'assertMember deve ser chamado exatamente uma vez');
  await app.close();
});

test('ts-5: MISCONFIGURED → 500', async () => {
  const app = buildApp({ pool: PANIC_POOL, authz: makeMemberMisconfigured() });
  const res = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, 'authz_misconfigured');
  await app.close();
});

test('ts-6: number_id ausente → gate roda mesmo assim → 403', async () => {
  const spy = makeMemberForbidden();
  const app = buildApp({ pool: PANIC_POOL, authz: spy });
  const res = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 403);
  assert.equal(spy.memberCalls, 1, 'gate deve ser alcançado mesmo sem number_id');
  await app.close();
});

// ── validação de params (antes do gate) ───────────────────────────────────────

test('ts-7: period_basis inválido → 400, gate não chamado', async () => {
  const spy = makeMemberForbidden();
  const app = buildApp({ pool: PANIC_POOL, authz: spy });
  const res = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1&period_basis=xpto`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "period_basis must be 'arrival' or 'activity'");
  assert.equal(spy.memberCalls, 0);
  await app.close();
});

test('ts-8: bucket inválido → 400, gate não chamado', async () => {
  const spy = makeMemberForbidden();
  const app = buildApp({ pool: PANIC_POOL, authz: spy });
  const res = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1&bucket=month`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "bucket must be 'day' or 'week'");
  assert.equal(spy.memberCalls, 0);
  await app.close();
});

test('ts-9: since > until → 400', async () => {
  const app = buildApp({ pool: PANIC_POOL, authz: makeMemberAllowed() });
  const res = await app.inject({
    method: 'GET',
    url: `${URL}?workspace_id=ws-1&since=2026-06-10T03:00:00Z&until=2026-06-01T03:00:00Z`,
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid since/until');
  await app.close();
});

// ── teto de buckets (FIX 4 — off-by-one) ──────────────────────────────────────

// Span de EXATAMENTE 200 dias. Buckets são inclusivos nas duas pontas, então isso
// emitiria 201 pontos — acima do teto. A fórmula antiga (`spanMs/step > 200`) media
// o span e deixava passar (200 > 200 é falso). Este teste ancora o off-by-one.
test('ts-10: span de 200 dias (emitiria 201 buckets) → 400', async () => {
  const app = buildApp({ pool: PANIC_POOL, authz: makeMemberAllowed() });
  const since = '2026-01-01T03:00:00Z';
  const until = new Date(Date.parse(since) + 200 * 86_400_000).toISOString();
  const res = await app.inject({
    method: 'GET',
    url: `${URL}?workspace_id=ws-1&since=${since}&until=${until}&bucket=day`,
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'window exceeds 200 buckets');
  await app.close();
});

test('ts-10b: bucket=week — span de 200 semanas → 400', async () => {
  const app = buildApp({ pool: PANIC_POOL, authz: makeMemberAllowed() });
  const since = '2026-01-01T03:00:00Z';
  const until = new Date(Date.parse(since) + 200 * 7 * 86_400_000).toISOString();
  const res = await app.inject({
    method: 'GET',
    url: `${URL}?workspace_id=ws-1&since=${since}&until=${until}&bucket=week`,
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

// Contraprova: uma janela larga porém dentro do teto NÃO pode ser rejeitada —
// senão o "fix" do off-by-one seria só um teto mais apertado.
test('ts-11: span de 30 dias → passa da guarda (200)', async () => {
  const { pool, calls } = makeStubPool();
  const app = buildApp({ pool, authz: makeMemberAllowed() });
  const res = await app.inject({
    method: 'GET',
    url: `${URL}?workspace_id=ws-1&since=2026-06-01T03:00:00Z&until=2026-07-01T02:59:59Z&bucket=day`,
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(findTimeseriesCall(calls), 'a query da série deve ter rodado');
  await app.close();
});

// ── defaults / envelope / repasse ─────────────────────────────────────────────

test('ts-12: since/until ausentes → default de janela de 30 dias', async () => {
  const { pool, calls } = makeStubPool();
  const app = buildApp({ pool, authz: makeMemberAllowed() });
  const res = await app.inject({ method: 'GET', url: `${URL}?workspace_id=ws-1`, headers: ACTOR_HEADERS });

  assert.equal(res.statusCode, 200);
  const call = findTimeseriesCall(calls);
  assert.ok(call, 'a query da série deve ter rodado');
  // $3=since, $4=until
  const spanMs = Date.parse(String(call!.params[3])) - Date.parse(String(call!.params[2]));
  const drift = Math.abs(spanMs - 30 * 86_400_000);
  assert.ok(drift < 5_000, `janela default deve ser ~30d, veio ${spanMs}ms`);
  // A janela default também tem que ser ecoada no envelope.
  assert.equal(res.json().window.since, call!.params[2]);
  assert.equal(res.json().window.until, call!.params[3]);
  await app.close();
});

test('ts-13: envelope whatsapp_v1 + eco de bucket/periodBasis/window/series', async () => {
  const { pool } = makeStubPool();
  const app = buildApp({ pool, authz: makeMemberAllowed() });
  const res = await app.inject({
    method: 'GET',
    url: `${URL}?workspace_id=ws-1&since=2026-06-01T03:00:00Z&until=2026-06-06T02:59:59Z&bucket=week&period_basis=activity`,
    headers: ACTOR_HEADERS,
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schema, 'whatsapp_v1');
  assert.equal(body.context.workspaceId, 'ws-1');
  assert.equal(body.bucket, 'week');
  assert.equal(body.periodBasis, 'activity');
  assert.deepEqual(body.window, { since: '2026-06-01T03:00:00Z', until: '2026-06-06T02:59:59Z' });
  assert.deepEqual(body.series, [], 'stub pool → série vazia');
  // Payload agregado: nada de identifier/texto de conversa vazando no envelope.
  assert.ok(!('identifier' in body), 'envelope não deve expor identifier');
  await app.close();
});

// `Number('') === 0`, NÃO NaN — o guard `isNaN(Number(number_id))` sozinho deixa
// `?number_id=` (vazio) passar e manda `whatsapp_number_id = 0` pro SQL, que não
// casa nada: 200 com série toda zerada em vez do agregado do workspace, em
// silêncio. `?number_id=%20%20` (whitespace) é o mesmo caso.
test('ts-15: number_id VAZIO/whitespace → $2=null (agregado do workspace), não 0', async () => {
  for (const raw of ['', '%20%20']) {
    const { pool, calls } = makeStubPool();
    const app = buildApp({ pool, authz: makeMemberAllowed() });
    const res = await app.inject({
      method: 'GET',
      url: `${URL}?workspace_id=ws-1&number_id=${raw}`,
      headers: ACTOR_HEADERS,
    });
    assert.equal(res.statusCode, 200, `number_id=${JSON.stringify(raw)} deve seguir como agregado do workspace`);
    const call = findTimeseriesCall(calls);
    assert.ok(call, 'a query da série deve ter rodado');
    assert.equal(call!.params[1], null, `number_id=${JSON.stringify(raw)} → $2 deve ser null, não 0`);
    await app.close();
  }
});

test('ts-14: period_basis default = arrival; kind inválido → all', async () => {
  const { pool, calls } = makeStubPool();
  const app = buildApp({ pool, authz: makeMemberAllowed() });
  const res = await app.inject({
    method: 'GET',
    url: `${URL}?workspace_id=ws-1&number_id=7&kind=xpto`,
    headers: ACTOR_HEADERS,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().periodBasis, 'arrival', 'period_basis ausente → arrival');
  const call = findTimeseriesCall(calls);
  assert.ok(call, 'a query da série deve ter rodado');
  assert.equal(call!.params[0], 'ws-1');   // $1 workspace
  assert.equal(call!.params[1], 7);        // $2 number_id
  assert.equal(call!.params[4], 'day');    // $5 bucket default
  assert.equal(call!.params[5], 'all');    // $6 kind inválido → all
  await app.close();
});
