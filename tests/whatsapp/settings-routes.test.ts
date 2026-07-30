import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthzError } from '../../src/whatsapp/authz.js';
import { registerSettingsRoutes } from '../../src/whatsapp/settings-routes.js';

const TOKEN = 'panel';
const headers = { 'x-panel-token': TOKEN, 'x-acting-user': 'user-1' };
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };

function makePool() {
  const state = {
    numbers: [{ id: 1, workspace_id: 'ws-1' }] as { id: number; workspace_id: string }[],
    settings: new Map<string, Record<string, any>>(),
  };
  const query = async (text: string, params: any[] = []) => {
    if (/FROM whatsapp_numbers WHERE id/.test(text)) {
      const num = state.numbers.find(n => n.id === Number(params[0]));
      return {
        rows: num ? [{ id: num.id, workspace_id: num.workspace_id, phone: '+5511', evolution_instance: 'i',
          label: 'N', status: 'connected', mode: 'monitored', expose_groups_in_mcp: false, created_by: null,
          created_at: new Date(), updated_at: new Date(), removed_at: null }] : [],
        rowCount: num ? 1 : 0,
      };
    }
    if (/INSERT INTO whatsapp_workspace_settings/.test(text)) {
      const workspaceId = params[0];
      if (!state.settings.has(workspaceId)) {
        state.settings.set(workspaceId, {
          workspace_id: workspaceId, auto_loss_days: 7, new_opp_after_days: 30,
          ai_engine_enabled: false, ai_lead_guidance: null, ai_qualified_guidance: null,
          pipeline_since: new Date('2026-01-01T00:00:00.000Z'),
        });
      }
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT workspace_id, auto_loss_days/.test(text) && /FROM whatsapp_workspace_settings/.test(text)) {
      const workspaceId = params[0];
      const row = state.settings.get(workspaceId);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/UPDATE whatsapp_workspace_settings SET/.test(text)) {
      const workspaceId = params[0];
      const row = state.settings.get(workspaceId);
      if (!row) return { rows: [], rowCount: 0 };
      const setClause = text.match(/SET (.+?)\s+WHERE/s)?.[1] ?? '';
      for (const part of setClause.split(',')) {
        const m = part.trim().match(/^(\w+)=\$(\d+)$/);
        if (!m) continue; // pula literais sem placeholder (ex.: updated_at=now())
        row[m[1]] = params[Number(m[2]) - 1];
      }
      return { rows: [row], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${text}`);
  };
  return { pool: { query } as any, state };
}

function appFor(pool: any, authz: any = passAuthz) {
  const app = Fastify({ logger: false });
  registerSettingsRoutes(app, { pool, panelToken: TOKEN, authz, logAccess: () => {} });
  return app;
}

test('GET sem X-Panel-Token → 401', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/settings?number_id=1' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET com member → 200, shape wire completo (snake_case, todos os campos, pipeline_since presente)', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/settings?number_id=1', headers });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schema, 'whatsapp_v1');
  assert.equal(body.context.workspaceId, 'ws-1');
  assert.deepEqual(Object.keys(body.settings).sort(), [
    'ai_engine_enabled', 'ai_lead_guidance', 'ai_qualified_guidance',
    'auto_loss_days', 'new_opp_after_days', 'pipeline_since',
  ].sort());
  assert.equal(body.settings.auto_loss_days, 7);
  assert.equal(body.settings.new_opp_after_days, 30);
  assert.equal(body.settings.ai_engine_enabled, false);
  assert.equal(body.settings.ai_lead_guidance, null);
  assert.equal(body.settings.ai_qualified_guidance, null);
  assert.equal(typeof body.settings.pipeline_since, 'string');
  assert.ok(body.settings.pipeline_since.length > 0);
  await app.close();
});

test('GET number_id inexistente → 404', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/settings?number_id=999', headers });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('PATCH como member não-admin → 403', async () => {
  const { pool } = makePool();
  const authz = { assertMember: async () => {}, assertAdmin: async () => { throw new AuthzError('forbidden', 'FORBIDDEN'); } };
  const app = appFor(pool, authz);
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/settings', headers,
    payload: { number_id: 1, new_opp_after_days: 15 } });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('PATCH admin válido: auto_loss_days null explícito limpa; new_opp_after_days=15 → 200 e campos atualizados', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/settings', headers,
    payload: { number_id: 1, auto_loss_days: null, new_opp_after_days: 15 } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.settings.auto_loss_days, null);
  assert.equal(body.settings.new_opp_after_days, 15);
  await app.close();
});

test('PATCH com pipeline_since no body → 400 (read-only)', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/settings', headers,
    payload: { number_id: 1, pipeline_since: '2026-01-01T00:00:00.000Z' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('PATCH com auto_loss_days=0 → 400', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/settings', headers,
    payload: { number_id: 1, auto_loss_days: 0 } });
  assert.equal(res.statusCode, 400);
  await app.close();
});
