import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthzError } from '../../src/whatsapp/authz.js';
import { registerOpportunityRoutes } from '../../src/whatsapp/opportunity-routes.js';

const TOKEN = 'panel';
const headers = { 'x-panel-token': TOKEN, 'x-acting-user': 'user-1' };
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };
const date = (n: number) => new Date(`2026-07-${String(n).padStart(2, '0')}T12:00:00.000Z`);

function makePool(opts: { conversation?: boolean; opportunities?: any[]; tags?: any[] } = {}) {
  const state = {
    opportunities: (opts.opportunities ?? []).map(o => ({ whatsapp_number_id: 1, workspace_id: 'ws-1',
      title: null, status: 'em_andamento', qualification: 'indefinido', created_by: 'user-1',
      updated_at: o.created_at, closed_at: null, tags: [], ...o })),
    events: [] as any[],
    tags: opts.tags ?? [{ id: 10, workspace_id: 'ws-1', name: 'VIP', color: 'warn' }],
    links: [] as { opportunity_id: number; tag_id: number }[],
    conversation: opts.conversation ?? true,
    nextId: Math.max(0, ...(opts.opportunities ?? []).map(o => Number(o.id))) + 1,
    updated: 0,
    queries: [] as { text: string; params: any[] }[],
  };
  const query = async (text: string, params: any[] = []) => {
    state.queries.push({ text, params });
    if (/FROM whatsapp_numbers WHERE id/.test(text)) return { rows: params[0] === 1 ? [{
      id: 1, workspace_id: 'ws-1', phone: '+5511', evolution_instance: 'i', label: 'N',
      status: 'connected', mode: 'monitored', expose_groups_in_mcp: false, created_by: null,
      created_at: date(1), updated_at: date(1), removed_at: null,
    }] : [], rowCount: params[0] === 1 ? 1 : 0 };
    if (/SELECT EXISTS/.test(text)) return { rows: [{ exists: state.conversation }], rowCount: 1 };
    if (/INSERT INTO whatsapp_opportunities/.test(text)) {
      const row = { id: state.nextId++, whatsapp_number_id: params[0], workspace_id: params[1],
        identifier: params[2], title: params[3], status: 'em_andamento', qualification: params[4],
        created_by: params[5], created_at: date(state.nextId), updated_at: date(state.nextId),
        closed_at: null, tags: [] };
      state.opportunities.push(row); return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (/INSERT INTO whatsapp_opportunity_events/.test(text)) {
      state.events.push({ id: state.events.length + 1, opportunity_id: params[0], field: params[1],
        old_value: params[2], new_value: params[3], changed_by: params[4], changed_at: date(state.events.length + 1) });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE whatsapp_opportunities SET/.test(text)) {
      const o = state.opportunities.find(x => x.id === Number(params[0]));
      if (!o) return { rows: [], rowCount: 0 };
      for (const field of ['status', 'qualification', 'title'] as const) {
        const match = text.match(new RegExp(`${field}=\\$(\\d+)`));
        if (match) o[field] = params[Number(match[1]) - 1];
      }
      o.updated_at = date(24);
      if (/closed_at=NOW/.test(text)) o.closed_at = date(24);
      if (/closed_at=NULL/.test(text)) o.closed_at = null;
      state.updated++; return { rows: [{ id: o.id }], rowCount: 1 };
    }
    if (/DELETE FROM whatsapp_opportunities /.test(text)) {
      const i = state.opportunities.findIndex(x => x.id === Number(params[0]));
      if (i >= 0) state.opportunities.splice(i, 1); return { rows: [], rowCount: i >= 0 ? 1 : 0 };
    }
    if (/SELECT name FROM whatsapp_tags/.test(text)) {
      const t = state.tags.find(x => x.id === Number(params[0]) && x.workspace_id === params[1]);
      return { rows: t ? [{ name: t.name }] : [], rowCount: t ? 1 : 0 };
    }
    if (/SELECT id, name FROM whatsapp_tags/.test(text)) {
      const ids = params[1] as number[]; const rows = state.tags.filter(t => t.workspace_id === params[0] && ids.includes(t.id));
      return { rows, rowCount: rows.length };
    }
    if (/INSERT INTO whatsapp_opportunity_tags/.test(text)) {
      const exists = state.links.some(x => x.opportunity_id === Number(params[0]) && x.tag_id === Number(params[1]));
      if (!exists) state.links.push({ opportunity_id: Number(params[0]), tag_id: Number(params[1]) });
      return { rows: exists ? [] : [{ tag_id: params[1] }], rowCount: exists ? 0 : 1 };
    }
    if (/DELETE FROM whatsapp_opportunity_tags/.test(text)) {
      const i = state.links.findIndex(x => x.opportunity_id === Number(params[0]) && x.tag_id === Number(params[1]));
      if (i >= 0) state.links.splice(i, 1); return { rows: i >= 0 ? [{ tag_id: params[1] }] : [], rowCount: i >= 0 ? 1 : 0 };
    }
    if (/FROM whatsapp_opportunity_events/.test(text)) return { rows: state.events.filter(e => e.opportunity_id === Number(params[0])), rowCount: state.events.length };
    if (/FROM whatsapp_opportunities o/.test(text)) {
      let rows = state.opportunities.map(o => ({ ...o, tags: state.links.filter(l => l.opportunity_id === o.id)
        .map(l => state.tags.find(t => t.id === l.tag_id)).filter(Boolean) }));
      if (/WHERE o.id = \$1/.test(text)) rows = rows.filter(o => o.id === Number(params[0]));
      else {
        const limit = Number(params.at(-1)); rows.sort((a, b) => +b.created_at - +a.created_at || b.id - a.id);
        if (/\(date_trunc\('milliseconds', o.created_at\), o.id\) </.test(text)) {
          const cursorId = Number(params.at(-2)); const cursorDate = +new Date(params.at(-3));
          rows = rows.filter(o => +o.created_at < cursorDate || (+o.created_at === cursorDate && o.id < cursorId));
        }
        rows = rows.slice(0, limit);
      }
      return { rows, rowCount: rows.length };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [], rowCount: null };
    if (/INSERT INTO whatsapp_access_log/.test(text)) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected SQL: ${text}`);
  };
  const client = { query, release() {} };
  return { pool: { query, connect: async () => client } as any, state };
}

function appFor(pool: any, authz: any = passAuthz) {
  const app = Fastify({ logger: false });
  registerOpportunityRoutes(app, { pool, panelToken: TOKEN, authz, logAccess: () => {} });
  return app;
}

test('401 sem token e 400 sem x-acting-user em escrita', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  assert.equal((await app.inject({ method: 'GET', url: '/whatsapp/opportunities?number_id=1' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/whatsapp/opportunities',
    headers: { 'x-panel-token': TOKEN }, payload: { number_id: 1, identifier: 'a' } })).statusCode, 400);
  await app.close();
});

test('POST conversa inexistente retorna 404', async () => {
  const { pool } = makePool({ conversation: false }); const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/opportunities', headers, payload: { number_id: 1, identifier: 'a' } });
  assert.equal(res.statusCode, 404); assert.equal(res.json().error, 'conversa não encontrada'); await app.close();
});

test('POST cria em_andamento e somente evento created', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/opportunities', headers,
    payload: { number_id: 1, identifier: 'a', qualification: 'qualificado' } });
  assert.equal(res.statusCode, 200); assert.equal(res.json().opportunity.status, 'em_andamento');
  assert.equal('numberId' in res.json().opportunity, false); assert.equal('workspaceId' in res.json().opportunity, false);
  assert.deepEqual(state.events.map(e => e.field), ['created']); await app.close();
});

test('POST com tag_ids gera created + tag_added com nome (paridade com attach e CLI)', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/opportunities', headers,
    payload: { number_id: 1, identifier: 'a', tag_ids: [10] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(state.events.map(e => [e.field, e.new_value]), [['created', null], ['tag_added', 'VIP']]);
  await app.close();
});

test('PATCH ganho qualifica, fecha e gera dois eventos; no-op não atualiza', async () => {
  const { pool, state } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1) }] }); const app = appFor(pool);
  const won = await app.inject({ method: 'PATCH', url: '/whatsapp/opportunities/1', headers, payload: { status: 'ganho' } });
  assert.equal(won.statusCode, 200); assert.equal(won.json().opportunity.qualification, 'qualificado');
  assert.ok(won.json().opportunity.closedAt); assert.deepEqual(state.events.map(e => e.field), ['status', 'qualification']);
  const updates = state.updated;
  const noop = await app.inject({ method: 'PATCH', url: '/whatsapp/opportunities/1', headers, payload: { status: 'ganho' } });
  assert.equal(noop.statusCode, 200); assert.equal(state.updated, updates); assert.equal(state.events.length, 2); await app.close();
});

test('PATCH desqualificar ganho retorna 409', async () => {
  const { pool } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1), status: 'ganho', qualification: 'qualificado' }] });
  const app = appFor(pool); const res = await app.inject({ method: 'PATCH', url: '/whatsapp/opportunities/1', headers, payload: { qualification: 'desqualificado' } });
  assert.equal(res.statusCode, 409); assert.deepEqual(res.json(), { error: 'desqualificar_ganho' }); await app.close();
});

test('PATCH somente title atualiza apenas o campo tocado', async () => {
  const { pool, state } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1) }] }); const app = appFor(pool);
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/opportunities/1', headers, payload: { title: 'Novo' } });
  assert.equal(res.statusCode, 200);
  const update = state.queries.find(q => /UPDATE whatsapp_opportunities SET/.test(q.text))!;
  assert.match(update.text, /title=\$2/); assert.doesNotMatch(update.text, /status=/); assert.doesNotMatch(update.text, /qualification=/);
  await app.close();
});

test('DELETE não-admin retorna 403', async () => {
  const { pool } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1) }] });
  const authz = { assertMember: async () => {}, assertAdmin: async () => { throw new AuthzError('forbidden', 'FORBIDDEN'); } };
  const app = appFor(pool, authz); const res = await app.inject({ method: 'DELETE', url: '/whatsapp/opportunities/1', headers });
  assert.equal(res.statusCode, 403); await app.close();
});

test('GET pagina com cursor opaco', async () => {
  const opportunities = [1, 2, 3].map(id => ({ id, identifier: `i${id}`, created_at: date(id) }));
  const { pool, state } = makePool({ opportunities }); const app = appFor(pool);
  const first = await app.inject({ method: 'GET', url: '/whatsapp/opportunities?number_id=1&status=em_andamento&identifier=i3&limit=2', headers });
  assert.equal(first.statusCode, 200); assert.equal(first.json().opportunities.length, 2); assert.ok(first.json().nextCursor);
  const second = await app.inject({ method: 'GET', url: `/whatsapp/opportunities?number_id=1&limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`, headers });
  assert.deepEqual(second.json().opportunities.map((o: any) => o.id), [1]); assert.equal(second.json().nextCursor, null); await app.close();
  const cursorQuery = state.queries.find(q => /\(date_trunc\('milliseconds', o.created_at\), o.id\) </.test(q.text))!;
  assert.match(cursorQuery.text, /ORDER BY date_trunc\('milliseconds', o.created_at\) DESC, o.id DESC/);
});

test('GET rejeita identifier repetido', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/opportunities?number_id=1&identifier=a&identifier=b', headers });
  assert.equal(res.statusCode, 400); assert.deepEqual(res.json(), { error: 'identifier invalido' }); await app.close();
});

test('tags attach/detach gera eventos com nome', async () => {
  const { pool, state } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1) }] }); const app = appFor(pool);
  assert.equal((await app.inject({ method: 'POST', url: '/whatsapp/opportunities/1/tags', headers, payload: { tag_id: 10 } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: '/whatsapp/opportunities/1/tags/10', headers })).statusCode, 200);
  assert.deepEqual(state.events.map(e => [e.field, e.new_value]), [['tag_added', 'VIP'], ['tag_removed', 'VIP']]); await app.close();
});
