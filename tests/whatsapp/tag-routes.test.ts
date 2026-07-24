import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthzError } from '../../src/whatsapp/authz.js';
import { registerTagRoutes } from '../../src/whatsapp/tag-routes.js';

const TOKEN = 'panel';
const headers = { 'x-panel-token': TOKEN, 'x-acting-user': 'user-1' };
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };

function makePool() {
  const state = {
    tags: [] as { id: number; workspace_id: string; name: string; color: string }[],
    links: [] as { opportunity_id: number; tag_id: number }[],
    nextId: 1,
  };
  const query = async (text: string, params: any[] = []) => {
    if (/FROM whatsapp_numbers WHERE id/.test(text)) {
      const workspace = Number(params[0]) === 1 ? 'ws-1' : Number(params[0]) === 2 ? 'ws-2' : null;
      return { rows: workspace ? [{ id: Number(params[0]), workspace_id: workspace, phone: '+5511',
        evolution_instance: 'i', label: 'N', status: 'connected', mode: 'monitored',
        expose_groups_in_mcp: false, created_by: null, created_at: new Date(), updated_at: new Date(),
        removed_at: null }] : [], rowCount: workspace ? 1 : 0 };
    }
    if (/SELECT t.id, t.name, t.color/.test(text)) {
      const rows = state.tags.filter(t => t.workspace_id === params[0]).map(t => ({ ...t,
        usage_count: state.links.filter(l => l.tag_id === t.id).length }));
      return { rows, rowCount: rows.length };
    }
    if (/INSERT INTO whatsapp_tags/.test(text)) {
      if (state.tags.some(t => t.workspace_id === params[0] && t.name.toLowerCase() === String(params[1]).toLowerCase())) {
        const error: any = new Error('duplicate'); error.code = '23505'; throw error;
      }
      const row = { id: state.nextId++, workspace_id: params[0], name: params[1], color: params[2] };
      state.tags.push(row); return { rows: [row], rowCount: 1 };
    }
    if (/UPDATE whatsapp_tags/.test(text)) {
      const tag = state.tags.find(t => t.id === Number(params[0]) && t.workspace_id === params[1]);
      if (!tag) return { rows: [], rowCount: 0 };
      const nameMatch = text.match(/name=\$(\d+)/); const colorMatch = text.match(/color=\$(\d+)/);
      const name = nameMatch ? params[Number(nameMatch[1]) - 1] : tag.name;
      if (state.tags.some(t => t.id !== tag.id && t.workspace_id === tag.workspace_id
        && t.name.toLowerCase() === String(name).toLowerCase())) {
        const error: any = new Error('duplicate'); error.code = '23505'; throw error;
      }
      if (nameMatch) tag.name = name;
      if (colorMatch) tag.color = params[Number(colorMatch[1]) - 1];
      return { rows: [tag], rowCount: 1 };
    }
    if (/DELETE FROM whatsapp_tags/.test(text)) {
      const i = state.tags.findIndex(t => t.id === Number(params[0]) && t.workspace_id === params[1]);
      if (i < 0) return { rows: [], rowCount: 0 };
      const [tag] = state.tags.splice(i, 1); state.links = state.links.filter(l => l.tag_id !== tag.id);
      return { rows: [{ id: tag.id }], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${text}`);
  };
  return { pool: { query } as any, state };
}

function appFor(pool: any, authz: any = passAuthz) {
  const app = Fastify({ logger: false });
  registerTagRoutes(app, { pool, panelToken: TOKEN, authz, logAccess: () => {} });
  return app;
}

test('cria tag normalizada e rejeita duplicata case-insensitive', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const created = await app.inject({ method: 'POST', url: '/whatsapp/tags', headers,
    payload: { number_id: 1, name: '  Cardio  Forte ', color: 'red' } });
  assert.equal(created.statusCode, 200); assert.equal(created.json().tag.name, 'Cardio Forte');
  const duplicate = await app.inject({ method: 'POST', url: '/whatsapp/tags', headers,
    payload: { number_id: 1, name: 'cardio forte', color: 'blue' } });
  assert.equal(duplicate.statusCode, 409); await app.close();
});

test('rejeita cor fora da paleta e nome vazio', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  assert.equal((await app.inject({ method: 'POST', url: '/whatsapp/tags', headers,
    payload: { number_id: 1, name: 'Cardio', color: 'magenta' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/whatsapp/tags', headers,
    payload: { number_id: 1, name: '   ', color: 'red' } })).statusCode, 400);
  await app.close();
});

test('GET inclui usageCount', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  state.tags.push({ id: 1, workspace_id: 'ws-1', name: 'VIP', color: 'amber' });
  state.links.push({ opportunity_id: 1, tag_id: 1 }, { opportunity_id: 2, tag_id: 1 });
  const res = await app.inject({ method: 'GET', url: '/whatsapp/tags?number_id=1', headers });
  assert.equal(res.statusCode, 200); assert.equal(res.json().tags[0].usageCount, 2); await app.close();
});

test('PATCH rename colidindo retorna 409', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  state.tags.push({ id: 1, workspace_id: 'ws-1', name: 'Cardio', color: 'red' },
    { id: 2, workspace_id: 'ws-1', name: 'VIP', color: 'blue' });
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/tags/2', headers,
    payload: { number_id: 1, name: 'cardio' } });
  assert.equal(res.statusCode, 409); await app.close();
});

test('DELETE nao-admin retorna 403', async () => {
  const { pool, state } = makePool(); state.tags.push({ id: 1, workspace_id: 'ws-1', name: 'VIP', color: 'red' });
  const authz = { assertMember: async () => {}, assertAdmin: async () => { throw new AuthzError('forbidden', 'FORBIDDEN'); } };
  const app = appFor(pool, authz);
  assert.equal((await app.inject({ method: 'DELETE', url: '/whatsapp/tags/1?number_id=1', headers })).statusCode, 403);
  await app.close();
});

test('tag de outro workspace retorna 404 em PATCH e DELETE', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  state.tags.push({ id: 1, workspace_id: 'ws-2', name: 'VIP', color: 'red' });
  assert.equal((await app.inject({ method: 'PATCH', url: '/whatsapp/tags/1', headers,
    payload: { number_id: 1, color: 'blue' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/whatsapp/tags/1?number_id=1', headers })).statusCode, 404);
  await app.close();
});
