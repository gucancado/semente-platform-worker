/**
 * tests/whatsapp/group-read-routes.test.ts
 *
 * Gate das rotas group-centric, DB-free (fake pool + authz injetado), molde de
 * read-routes.authz.test.ts.
 *
 * O caso que dá nome à feature é o (e): o gate roda no workspace VINCULADO, e
 * roda ANTES de resolver o vínculo — um não-admin recebe 403 sem descobrir se o
 * grupo existe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthzError } from '../../src/whatsapp/authz.js';
import { registerGroupReadRoutes } from '../../src/whatsapp/group-read-routes.js';
import type { RouteAuthz } from '../../src/whatsapp/route-authz.js';

const PANEL_TOKEN = 'test-panel';
const PANEL_HEADERS = { 'x-panel-token': PANEL_TOKEN };
const ACTOR_HEADERS = { 'x-panel-token': PANEL_TOKEN, 'x-acting-user': 'user-abc' };

const PANIC_POOL = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'query') return () => Promise.reject(new Error('DB não pode ser chamado antes do gate'));
    return undefined;
  },
}) as any;

/** Pool que resolve o vínculo (SELECT do group-links) e nada mais. */
function makeLinkPool(rows: any[]) {
  return {
    query: async (sql: string) => {
      if (sql.includes('whatsapp_groups')) return { rows };
      throw new Error(`DB call inesperada: ${sql}`);
    },
  } as any;
}

const LINK_ROW = {
  id: 7, jid: '+120363001', subject: 'Symmetry CWB + BeeAds',
  whatsapp_number_id: 3, number_workspace_id: 'ws-saturno', linked_workspace_id: 'ws-cliente',
};

function adminForbidden(): RouteAuthz & { adminCalls: number } {
  return {
    adminCalls: 0,
    async assertMember() { /* passa: prova que a rota NÃO usa member */ },
    async assertAdmin() { this.adminCalls++; throw new AuthzError('forbidden', 'FORBIDDEN'); },
  };
}
function allPass(): RouteAuthz & { adminWorkspaces: string[]; memberWorkspaces: string[] } {
  return {
    adminWorkspaces: [],
    memberWorkspaces: [],
    async assertMember(_u, w) { this.memberWorkspaces.push(w); },
    async assertAdmin(_u, w) { this.adminWorkspaces.push(w); },
  };
}
/** Admin do workspace do cliente, mas NÃO membro do workspace do número (= pessoa do cliente). */
function adminButNotTeam(): RouteAuthz {
  return {
    async assertMember(_u, _w) { throw new AuthzError('forbidden', 'FORBIDDEN'); },
    async assertAdmin() { /* passa */ },
  };
}
const noopLog = () => {};

test('(a) GET /whatsapp/groups — workspace_id ausente → 400, sem DB', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: allPass(), logAccess: noopLog });
  const res = await app.inject({ method: 'GET', url: '/whatsapp/groups', headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('(b) GET /whatsapp/groups — actor ausente → 400, assertAdmin não chamado', async () => {
  const spy = adminForbidden();
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy, logAccess: noopLog });
  const res = await app.inject({ method: 'GET', url: '/whatsapp/groups?workspace_id=ws-cliente', headers: PANEL_HEADERS });
  assert.equal(res.statusCode, 400);
  assert.equal(spy.adminCalls, 0);
  await app.close();
});

test('(c) GET /whatsapp/groups — não-admin → 403', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: adminForbidden(), logAccess: noopLog });
  const res = await app.inject({ method: 'GET', url: '/whatsapp/groups?workspace_id=ws-cliente', headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('(d) GET /whatsapp/groups — admin sem vínculo → 200 com lista vazia', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool: makeLinkPool([]), panelToken: PANEL_TOKEN, authz: allPass(), logAccess: noopLog });
  const res = await app.inject({ method: 'GET', url: '/whatsapp/groups?workspace_id=ws-cliente', headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().groups, []);
  assert.equal(res.json().schema, 'group_v1');
  await app.close();
});

test('(e) messages — não-admin com jid inexistente → 403 (não 404): o gate roda ANTES do vínculo', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: adminForbidden(), logAccess: noopLog });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/groups/%2B999999/messages?workspace_id=ws-cliente',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 403, 'não-admin não pode distinguir grupo inexistente de existente');
  await app.close();
});

test('(f) messages — admin, jid não vinculado a ESTE workspace → 404 group_not_linked', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool: makeLinkPool([]), panelToken: PANEL_TOKEN, authz: allPass(), logAccess: noopLog });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/groups/%2B120363001/messages?workspace_id=ws-cliente',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'group_not_linked');
  await app.close();
});

// O furo que o gate duplo fecha: quem é admin do workspace do CLIENTE mas não é
// da equipe (típico: o próprio cliente) não pode ler a conversa interna SOBRE ele.
test('(e2) messages — admin do cliente que NÃO é da equipe → 403', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, {
    pool: makeLinkPool([LINK_ROW]), panelToken: PANEL_TOKEN, authz: adminButNotTeam(), logAccess: noopLog,
  });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/groups/%2B120363001/messages?workspace_id=ws-cliente',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('(e3) list — grupo cujo número o ator não é membro NÃO entra na lista', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, {
    pool: makeLinkPool([LINK_ROW]), panelToken: PANEL_TOKEN, authz: adminButNotTeam(), logAccess: noopLog,
  });
  const res = await app.inject({ method: 'GET', url: '/whatsapp/groups?workspace_id=ws-cliente', headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().groups, [], 'lista vazia, não 403: não revela que o vínculo existe');
  await app.close();
});

test('(g) messages — o gate é feito no workspace VINCULADO (o da query), não no do número', async () => {
  const spy = allPass();
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('whatsapp_groups')) return { rows: [LINK_ROW] };
      return { rows: [] }; // listThreadMessages → sem mensagens
    },
  } as any;
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: spy, logAccess: noopLog });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/groups/%2B120363001/messages?workspace_id=ws-cliente',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(spy.adminWorkspaces, ['ws-cliente'], 'gate 1 (admin) no workspace do CLIENTE');
  assert.deepEqual(spy.memberWorkspaces, ['ws-saturno'], 'gate 2 (equipe) no workspace do NÚMERO');
  await app.close();
});

test('(h) messages — a query de mensagens usa o workspace do NÚMERO, não o do cliente', async () => {
  const seen: any[][] = [];
  const pool = {
    query: async (sql: string, params: any[]) => {
      if (sql.includes('whatsapp_groups')) return { rows: [LINK_ROW] };
      seen.push(params);
      return { rows: [] };
    },
  } as any;
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: allPass(), logAccess: noopLog });
  await app.inject({
    method: 'GET',
    url: '/whatsapp/groups/%2B120363001/messages?workspace_id=ws-cliente',
    headers: ACTOR_HEADERS,
  });
  // listThreadMessages: [numberId, identifier, before, limit, since, until, workspaceId]
  assert.equal(seen[0][0], 3, 'numberId do vínculo');
  assert.equal(seen[0][1], '+120363001', 'identifier = jid do vínculo');
  assert.equal(seen[0][6], 'ws-saturno', 'workspace do NÚMERO (é o que está em messages.workspace_id)');
  await app.close();
});

test('(i) export — não-admin → 403', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: adminForbidden(), logAccess: noopLog });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/groups/%2B120363001/export?workspace_id=ws-cliente',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('(j) auditoria registra o workspace do CLIENTE', async () => {
  const logged: any[] = [];
  const pool = {
    query: async (sql: string) => (sql.includes('whatsapp_groups') ? { rows: [LINK_ROW] } : { rows: [] }),
  } as any;
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, {
    pool, panelToken: PANEL_TOKEN, authz: allPass(),
    logAccess: ((_p: any, e: any) => { logged.push(e); }) as any,
  });
  await app.inject({
    method: 'GET',
    url: '/whatsapp/groups/%2B120363001/messages?workspace_id=ws-cliente',
    headers: ACTOR_HEADERS,
  });
  assert.equal(logged[0].workspaceId, 'ws-cliente');
  assert.equal(logged[0].action, 'group_messages');
  assert.equal(logged[0].identifier, '+120363001');
  await app.close();
});
