/**
 * tests/whatsapp/group-search-routes.test.ts — rotas /search e /view?around,
 * DB-free (fake pool + authz injetado), molde de group-read-routes.test.ts.
 * Validação de INPUT (q, around) roda ANTES do gate (mesma classe do
 * `workspace_id required`) — 400 de formato não revela nada; a ordem
 * ws→actor→admin→vínculo segue intacta pro caminho válido.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthzError } from '../../src/whatsapp/authz.js';
import { registerGroupReadRoutes } from '../../src/whatsapp/group-read-routes.js';
import type { RouteAuthz } from '../../src/whatsapp/route-authz.js';

const PANEL_TOKEN = 'test-panel';
const ACTOR_HEADERS = { 'x-panel-token': PANEL_TOKEN, 'x-acting-user': 'user-abc' };

const PANIC_POOL = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'query') return () => Promise.reject(new Error('DB não pode ser chamado antes do gate'));
    return undefined;
  },
}) as any;

const AGENT_LINK_ROW = {
  id: 11, jid: '+120363099', subject: 'Grupo da organização',
  whatsapp_number_id: null, number_workspace_id: null, agent: 'saturno', linked_workspace_id: 'ws-cliente',
};

const MSG_ROW = {
  id: 42, direction: 'inbound', text: 'achou o alvo aqui', agent: 'saturno',
  created_at: new Date('2026-08-01T12:00:00Z'), author: '+5531999998888', kind: 'text',
  transcription_status: null, media_duration_s: null, media_key: null, author_name: 'Fulano',
};

/** Pool roteado por substring — participants ANTES de groups (o SELECT do roster contém as duas). */
function makePool(h: { search?: any[]; anchor?: any[]; window?: any[]; participants?: any[]; link?: any[] }) {
  return {
    query: async (sql: string) => {
      if (sql.includes('whatsapp_group_participants')) return { rows: h.participants ?? [] };
      if (sql.includes('ILIKE')) return { rows: h.search ?? [] };
      if (/m\.id\s*=\s*\$\d+::bigint/.test(sql)) return { rows: h.anchor ?? [] };
      if (sql.includes('(m.created_at, m.id)')) return { rows: h.window ?? [] };
      if (sql.includes('LIMIT $4')) return { rows: [] };
      if (sql.includes('whatsapp_groups')) return { rows: h.link ?? [] };
      throw new Error(`DB call inesperada: ${sql}`);
    },
  } as any;
}

function adminSpy(): RouteAuthz & { adminCalls: number } {
  return {
    adminCalls: 0,
    async assertMember() {},
    async assertAdmin() { this.adminCalls++; },
  };
}
function adminForbidden(): RouteAuthz & { adminCalls: number } {
  return {
    adminCalls: 0,
    async assertMember() {},
    async assertAdmin() { this.adminCalls++; throw new AuthzError('forbidden', 'FORBIDDEN'); },
  };
}
const noopLog = () => {};
const URL_BASE = '/whatsapp/groups/%2B120363099';

test('search: q ausente/curto → 400 q_too_short, sem authz nem DB', async () => {
  const spy = adminSpy();
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy, logAccess: noopLog });
  for (const qs of ['', '&q=a', '&q=%20%20a%20']) {
    const res = await app.inject({ method: 'GET', url: `${URL_BASE}/search?workspace_id=ws-cliente${qs}`, headers: ACTOR_HEADERS });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'q_too_short');
  }
  assert.equal(spy.adminCalls, 0);
  await app.close();
});

test('search: q >200 chars → 400 q_too_long', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: adminSpy(), logAccess: noopLog });
  const res = await app.inject({ method: 'GET', url: `${URL_BASE}/search?workspace_id=ws-cliente&q=${'a'.repeat(201)}`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'q_too_long');
  await app.close();
});

test('search: não-admin → 403 antes de resolver vínculo', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: adminForbidden(), logAccess: noopLog });
  const res = await app.inject({ method: 'GET', url: `${URL_BASE}/search?workspace_id=ws-cliente&q=alvo`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('search: vínculo ausente → 404 group_not_linked', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool: makePool({ link: [] }), panelToken: PANEL_TOKEN, authz: adminSpy(), logAccess: noopLog });
  const res = await app.inject({ method: 'GET', url: `${URL_BASE}/search?workspace_id=ws-cliente&q=alvo`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('search: sucesso escopo agent → hits com snippet, sem campo text integral', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, {
    pool: makePool({ link: [AGENT_LINK_ROW], search: [MSG_ROW] }),
    panelToken: PANEL_TOKEN, authz: adminSpy(), logAccess: noopLog,
  });
  const res = await app.inject({ method: 'GET', url: `${URL_BASE}/search?workspace_id=ws-cliente&q=alvo`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schema, 'group_v1');
  assert.equal(body.truncated, false);
  assert.deepEqual(body.hits, [{
    id: 42, createdAt: '2026-08-01T12:00:00.000Z', direction: 'inbound',
    author: '+5531999998888', authorName: 'Fulano', snippet: 'achou o alvo aqui',
  }]);
  await app.close();
});

test('view: around não-numérico → 400 around_invalid, sem authz', async () => {
  const spy = adminSpy();
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, { pool: PANIC_POOL, panelToken: PANEL_TOKEN, authz: spy, logAccess: noopLog });
  const res = await app.inject({ method: 'GET', url: `${URL_BASE}/view?workspace_id=ws-cliente&around=abc`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'around_invalid');
  assert.equal(spy.adminCalls, 0);
  await app.close();
});

test('view: around fora do escopo do grupo → 404 message_not_in_group', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, {
    pool: makePool({ link: [AGENT_LINK_ROW], anchor: [] }),
    panelToken: PANEL_TOKEN, authz: adminSpy(), logAccess: noopLog,
  });
  const res = await app.inject({ method: 'GET', url: `${URL_BASE}/view?workspace_id=ws-cliente&around=999`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'message_not_in_group');
  await app.close();
});

test('view: around válido → payload com anchorId + mensagens da janela + participants', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, {
    pool: makePool({ link: [AGENT_LINK_ROW], anchor: [{ id: 42, created_at: new Date('2026-08-01T12:00:00Z') }], window: [MSG_ROW], participants: [] }),
    panelToken: PANEL_TOKEN, authz: adminSpy(), logAccess: noopLog,
  });
  const res = await app.inject({ method: 'GET', url: `${URL_BASE}/view?workspace_id=ws-cliente&around=42`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.anchorId, 42);
  assert.equal(body.messages.length, 2); // MSG_ROW nas duas metades do fake (mesmo handler) — só confirma que a janela alimentou o payload
  assert.ok(Array.isArray(body.participants));
  await app.close();
});

test('view: SEM around → comportamento atual intocado (sem anchorId)', async () => {
  const app = Fastify({ logger: false });
  registerGroupReadRoutes(app, {
    pool: makePool({ link: [AGENT_LINK_ROW], participants: [], window: [], search: [], anchor: [] }),
    panelToken: PANEL_TOKEN, authz: adminSpy(), logAccess: noopLog,
  });
  // o caminho sem around usa listGroupMessagesByAgent — o makePool não tem case
  // pra ele; adicionar: SQL contém 'ORDER BY m.created_at' e '$3' de cursor.
  // Ver Step 3: se o teste quebrar por "DB call inesperada", acrescentar ao
  // makePool: `if (sql.includes('LIMIT $4')) return { rows: [] };` ANTES do
  // case de whatsapp_groups.
  const res = await app.inject({ method: 'GET', url: `${URL_BASE}/view?workspace_id=ws-cliente`, headers: ACTOR_HEADERS });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().anchorId, undefined);
  await app.close();
});
