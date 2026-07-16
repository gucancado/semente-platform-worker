/**
 * tests/whatsapp/audit-routes.test.ts
 *
 * DB-FREE param/gate tests for GET /whatsapp/audit.
 *
 * Foco: `?number_id=` (vazio/whitespace) NÃO pode virar `0` e zerar o feed de
 * auditoria — `Number('') === 0` (não NaN), então um guard que só testa
 * `isNaN(Number(v))` deixa passar e manda `whatsapp_number_id = 0` pro SQL, que
 * não casa nada: 200 com feed VAZIO em vez do log do workspace, em silêncio. Num
 * endpoint de auditoria LGPD, "nada aconteceu" é uma resposta errada com peso.
 * Mesma classe de bug já corrigida em /whatsapp/stats, /stats/timeseries e
 * /first-response na Fase 2 (parseNumberId).
 *
 * Estratégia: fake authz (admin) + stub pool que captura os params das queries,
 * sem Postgres real. A cobertura DB do próprio listAccessLog fica em
 * audit-queries.db.test.ts (não muda com este fix — o bug é na rota).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthzError } from '../../src/whatsapp/authz.js';
import { registerReadRoutes } from '../../src/whatsapp/read-routes.js';
import type { RouteAuthz } from '../../src/whatsapp/route-authz.js';

// ── Fake pool: panics if any query is actually executed (gate-order proof) ─────
const PANIC_POOL = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'query') {
        return () => Promise.reject(new Error('DB should not be called before gate resolves'));
      }
      return undefined;
    },
  },
) as any;

// audit é ADMIN-only → o authz precisa liberar assertAdmin.
function makeAdminAllowed(): RouteAuthz {
  return {
    async assertMember() { /* allow */ },
    async assertAdmin() { /* allow */ },
  };
}

function makeAdminForbidden(): RouteAuthz & { adminCalls: number } {
  return {
    adminCalls: 0,
    async assertMember() { /* allow */ },
    async assertAdmin() { this.adminCalls++; throw new AuthzError('forbidden', 'FORBIDDEN'); },
  };
}

// Stub pool: records every query() call, returns empty rows.
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
const ADMIN_HEADERS = { 'x-panel-token': PANEL_TOKEN, 'x-acting-user': 'user-abc' };

// audit-nid-1 (RED antes do fix): `?number_id=` vazio/whitespace deve virar
// $2=null (feed do workspace inteiro), NÃO 0 (feed vazio silencioso).
// `FROM whatsapp_access_log` isola o SELECT do listAccessLog; params[1] é o
// numberId ($2). logAccess é injetado no-op pra não emitir o INSERT no mesmo alvo.
test('audit-nid-1: GET /whatsapp/audit?number_id= (vazio/whitespace) → $2=null, não 0', async () => {
  for (const raw of ['', '%20%20']) {
    const { pool, calls } = makeStubPool();
    const app = Fastify({ logger: false });
    registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: makeAdminAllowed(), logAccess: () => {} });

    const res = await app.inject({
      method: 'GET',
      url: `/whatsapp/audit?workspace_id=ws-1&number_id=${raw}`,
      headers: ADMIN_HEADERS,
    });

    assert.equal(res.statusCode, 200, `number_id=${JSON.stringify(raw)} deve seguir como feed do workspace`);
    const auditCall = calls.find((c) => /FROM whatsapp_access_log/.test(c.text));
    assert.ok(auditCall, 'a query do access_log deve rodar');
    assert.equal(auditCall!.params[1], null, `number_id=${JSON.stringify(raw)} → $2 deve ser null, não 0`);
    await app.close();
  }
});

// audit-nid-2 (regressão): number_id válido é honrado como filtro ($2=5).
test('audit-nid-2: GET /whatsapp/audit?number_id=5 → $2=5', async () => {
  const { pool, calls } = makeStubPool();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: makeAdminAllowed(), logAccess: () => {} });

  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/audit?workspace_id=ws-1&number_id=5',
    headers: ADMIN_HEADERS,
  });

  assert.equal(res.statusCode, 200);
  const auditCall = calls.find((c) => /FROM whatsapp_access_log/.test(c.text));
  assert.ok(auditCall, 'a query do access_log deve rodar');
  assert.equal(auditCall!.params[1], 5, 'number_id=5 → $2=5');
  await app.close();
});

// audit-limit-1 (RED antes do fix): `?limit=` vazio/whitespace deve cair pro
// default 50, NÃO virar LIMIT 0 (feed vazio silencioso — mesma classe LGPD do
// number_id, no mesmo endpoint). $8 (limit) é params[7] em audit-queries.ts.
test('audit-limit-1: GET /whatsapp/audit?limit= (vazio/whitespace) → LIMIT 50, não 0', async () => {
  for (const raw of ['', '%20%20']) {
    const { pool, calls } = makeStubPool();
    const app = Fastify({ logger: false });
    registerReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: makeAdminAllowed(), logAccess: () => {} });

    const res = await app.inject({
      method: 'GET',
      url: `/whatsapp/audit?workspace_id=ws-1&limit=${raw}`,
      headers: ADMIN_HEADERS,
    });

    assert.equal(res.statusCode, 200, `limit=${JSON.stringify(raw)} deve seguir com o default`);
    const auditCall = calls.find((c) => /FROM whatsapp_access_log/.test(c.text));
    assert.ok(auditCall, 'a query do access_log deve rodar');
    assert.equal(auditCall!.params[7], 50, `limit=${JSON.stringify(raw)} → LIMIT 50, não 0`);
    await app.close();
  }
});

// audit-limit-2 (regressão): limit não-numérico → 400.
test('audit-limit-2: GET /whatsapp/audit?limit=abc → 400', async () => {
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: makeAdminAllowed(), logAccess: () => {} });

  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/audit?workspace_id=ws-1&limit=abc',
    headers: ADMIN_HEADERS,
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'limit must be numeric');
  await app.close();
});

// audit-nid-3 (regressão): number_id não-numérico → 400 ANTES do gate admin,
// DB nunca tocado (PANIC_POOL prova).
test('audit-nid-3: GET /whatsapp/audit?number_id=abc → 400, gate não chamado, DB não tocado', async () => {
  const spy = makeAdminForbidden();
  const app = Fastify({ logger: false });
  registerReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy });

  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/audit?workspace_id=ws-1&number_id=abc',
    headers: ADMIN_HEADERS,
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'number_id must be numeric');
  assert.equal(spy.adminCalls, 0, 'gate admin não deve ser alcançado com number_id inválido');
  await app.close();
});
