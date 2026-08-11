/**
 * tests/whatsapp/group-read-routes.test.ts
 *
 * Gate das rotas group-centric, DB-free (fake pool + authz injetado), molde de
 * read-routes.authz.test.ts.
 *
 * O caso que dá nome à feature é o (e): o gate roda no workspace VINCULADO, e
 * roda ANTES de resolver o vínculo — um não-admin recebe 403 sem descobrir se o
 * grupo existe.
 *
 * ⚠️ GATE 2 REMOVIDO (decisão de produto, 2026-08-11): esta suíte tinha testes
 * (e2/e3) que provavam "admin do cliente que NÃO é da equipe → 403" — um
 * segundo gate que checava membership no workspace do NÚMERO. Ficou sem como
 * funcionar quando o número real (organização) deixou de ter workspace
 * próprio, e foi removido de propósito em group-read-routes.ts. Esses dois
 * testes foram REMOVIDOS (não é regressão despercebida — é o comportamento
 * novo, documentado aqui e em group-links.ts/group-read-routes.ts). A
 * autorização hoje é só gate 1 (admin do workspace vinculado).
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
  whatsapp_number_id: 3, number_workspace_id: 'ws-saturno', agent: null, linked_workspace_id: 'ws-cliente',
};

// A linha "da organização": legada, sem número, agent='saturno' — hoje o
// único caso real em produção (51 grupos, número nunca migrado pra
// whatsapp_numbers).
const AGENT_LINK_ROW = {
  id: 11, jid: '+120363099', subject: 'Grupo da organização',
  whatsapp_number_id: null, number_workspace_id: null, agent: 'saturno', linked_workspace_id: 'ws-cliente',
};

function adminForbidden(): RouteAuthz & { adminCalls: number } {
  return {
    adminCalls: 0,
    async assertMember() { /* não deveria mais ser chamado — gate 2 saiu */ },
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

test('(g) messages — o gate é feito no workspace VINCULADO; gate 2 não roda mais (assertMember não é chamado)', async () => {
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
  assert.deepEqual(spy.memberWorkspaces, [], 'gate 2 foi removido — assertMember nunca é chamado');
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

test('(k) messages — escopo agent despacha pra listGroupMessagesByAgent (agent + identifier, sem número)', async () => {
  const seen: any[][] = [];
  const pool = {
    query: async (sql: string, params: any[]) => {
      if (sql.includes('whatsapp_groups')) return { rows: [AGENT_LINK_ROW] };
      seen.push(params);
      return { rows: [] };
    },
  } as any;
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: allPass(), logAccess: noopLog });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/groups/%2B120363099/messages?workspace_id=ws-cliente',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 200);
  // listGroupMessagesByAgent: [agent, identifier, before, limit, since, until]
  assert.equal(seen[0][0], 'saturno', 'agent do vínculo');
  assert.equal(seen[0][1], '+120363099', 'identifier = jid do vínculo');
  await app.close();
});

test('(l) export — escopo agent responde 501 explícito (export não é number-scoped nessa linha)', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, {
    pool: makeLinkPool([AGENT_LINK_ROW]), panelToken: PANEL_TOKEN, authz: allPass(), logAccess: noopLog,
  });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/groups/%2B120363099/export?workspace_id=ws-cliente',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().error, 'export_nao_suportado_para_grupo_da_organizacao');
  await app.close();
});

test('(m) participants — escopo agent devolve [] sem tocar em whatsapp_group_participants', async () => {
  const app = Fastify({ logger: false });
  // Qualquer query além da de whatsapp_groups derruba o teste — prova que
  // listParticipants nem é chamado no escopo agent.
  registerGroupReadRoutes(app, {
    pool: makeLinkPool([AGENT_LINK_ROW]), panelToken: PANEL_TOKEN, authz: allPass(), logAccess: noopLog,
  });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/groups/%2B120363099/participants?workspace_id=ws-cliente',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().participants, []);
  await app.close();
});

test('(n) view — escopo agent devolve mensagens + participants:[] (sem número)', async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('whatsapp_groups')) return { rows: [AGENT_LINK_ROW] };
      return { rows: [] }; // listGroupMessagesByAgent → sem mensagens
    },
  } as any;
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool, panelToken: PANEL_TOKEN, authz: allPass(), logAccess: noopLog });
  const res = await app.inject({
    method: 'GET',
    url: '/whatsapp/groups/%2B120363099/view?workspace_id=ws-cliente',
    headers: ACTOR_HEADERS,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.participants, []);
  assert.deepEqual(body.messages, []);
  assert.equal(body.context.numberId, null);
  assert.equal(body.context.scope, 'agent');
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
