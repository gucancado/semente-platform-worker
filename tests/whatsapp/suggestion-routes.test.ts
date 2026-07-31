import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthzError } from '../../src/whatsapp/authz.js';
import { registerSuggestionRoutes } from '../../src/whatsapp/suggestion-routes.js';

const TOKEN = 'panel';
const headers = { 'x-panel-token': TOKEN, 'x-acting-user': 'user-1' };
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };

function makePool() {
  const state = {
    numbers: [{ id: 1, workspace_id: 'ws-1' }, { id: 2, workspace_id: 'ws-2' }] as { id: number; workspace_id: string }[],
    suggestions: new Map<number, Record<string, any>>(),
    insights: [] as Record<string, any>[],
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
    // resolveSuggestion (UPDATE) — checar ANTES do SELECT genérico.
    if (/UPDATE whatsapp_ai_suggestions\s+SET/.test(text)) {
      const [id, status, resolvedBy] = params;
      const row = state.suggestions.get(Number(id));
      if (!row || row.status !== 'pending') return { rows: [], rowCount: 0 };
      row.status = status;
      row.resolved_at = new Date();
      row.resolved_by = resolvedBy;
      return { rows: [row], rowCount: 1 };
    }
    // listPendingSuggestions
    if (/FROM whatsapp_ai_suggestions/.test(text) && /WHERE workspace_id = \$1 AND status = 'pending'/.test(text)) {
      const workspaceId = params[0];
      const rows = [...state.suggestions.values()].filter(r => r.workspace_id === workspaceId && r.status === 'pending');
      return { rows, rowCount: rows.length };
    }
    // getSuggestion (SELECT by id, sem filtro de workspace)
    if (/FROM whatsapp_ai_suggestions/.test(text) && /WHERE id = \$1/.test(text)) {
      const row = state.suggestions.get(Number(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    // listInsights
    if (/FROM whatsapp_ai_insights/.test(text)) {
      const [workspaceId, limit] = params;
      const rows = state.insights
        .filter(r => r.workspace_id === workspaceId)
        .sort((a, b) => b.run_at.getTime() - a.run_at.getTime())
        .slice(0, Number(limit));
      return { rows, rowCount: rows.length };
    }
    // getOrCreateSettings
    if (/INSERT INTO whatsapp_workspace_settings/.test(text)) {
      const workspaceId = params[0];
      if (!state.settings.has(workspaceId)) {
        state.settings.set(workspaceId, {
          workspace_id: workspaceId, auto_loss_days: 7, new_opp_after_days: 30,
          ai_engine_enabled: true, ai_lead_guidance: 'guidance antiga', ai_qualified_guidance: null,
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
        if (!m) continue;
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
  registerSuggestionRoutes(app, { pool, panelToken: TOKEN, authz, logAccess: () => {} });
  return app;
}

function seedSuggestion(state: ReturnType<typeof makePool>['state'], overrides: Partial<Record<string, any>> = {}) {
  const row = {
    id: 1, workspace_id: 'ws-1', kind: 'guidance_lead',
    payload: { current: 'guidance antiga', suggested: 'guidance nova', reason: 'recorrência de X' },
    status: 'pending', created_at: new Date('2026-07-27T10:00:00.000Z'), resolved_at: null, resolved_by: null,
    ...overrides,
  };
  state.suggestions.set(row.id, row);
  return row;
}

// ── GET /whatsapp/suggestions ───────────────────────────────────────────────────

test('GET sem X-Panel-Token → 401', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/suggestions?number_id=1' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET sem number_id → 400', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/suggestions', headers });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('GET number_id inexistente → 404', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/suggestions?number_id=999', headers });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET status != pending → 400', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/suggestions?number_id=1&status=applied', headers });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('GET member → 200, lista pendentes do workspace (wire snake_case)', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  seedSuggestion(state);
  seedSuggestion(state, { id: 2, workspace_id: 'ws-2' }); // outro workspace, não deve aparecer
  const res = await app.inject({ method: 'GET', url: '/whatsapp/suggestions?number_id=1&status=pending', headers });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schema, 'whatsapp_v1');
  assert.equal(body.suggestions.length, 1);
  assert.equal(body.suggestions[0].id, 1);
  assert.equal(body.suggestions[0].kind, 'guidance_lead');
  assert.deepEqual(body.suggestions[0].payload, { current: 'guidance antiga', suggested: 'guidance nova', reason: 'recorrência de X' });
  assert.equal(body.suggestions[0].status, 'pending');
  await app.close();
});

// ── POST /:id/apply ──────────────────────────────────────────────────────────────

test('POST apply como member não-admin → 403', async () => {
  const { pool, state } = makePool();
  const authz = { assertMember: async () => {}, assertAdmin: async () => { throw new AuthzError('forbidden', 'FORBIDDEN'); } };
  const app = appFor(pool, authz);
  seedSuggestion(state);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/suggestions/1/apply', headers, payload: { number_id: 1 } });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST apply sem x-acting-user → 400', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  seedSuggestion(state);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/suggestions/1/apply',
    headers: { 'x-panel-token': TOKEN }, payload: { number_id: 1 } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST apply id de OUTRO workspace → 404 (não vaza cross-tenant)', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  seedSuggestion(state, { id: 1, workspace_id: 'ws-2' }); // suggestion pertence a ws-2
  const res = await app.inject({ method: 'POST', url: '/whatsapp/suggestions/1/apply', headers, payload: { number_id: 1 } }); // number_id=1 → ws-1
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST apply guidance_lead: aplica settings (ai_lead_guidance) + resolve applied → 200', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  seedSuggestion(state, { kind: 'guidance_lead', payload: { current: 'antiga', suggested: 'nova guidance de lead', reason: 'r' } });
  const res = await app.inject({ method: 'POST', url: '/whatsapp/suggestions/1/apply', headers, payload: { number_id: 1 } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.applied, true);
  assert.equal(body.suggestion.status, 'applied');
  assert.equal(body.suggestion.resolved_by, 'user-1');
  assert.equal(body.settings.ai_lead_guidance, 'nova guidance de lead');
  assert.equal(state.settings.get('ws-1')?.updated_by, 'user-1', 'settings.updatedBy é o ator HUMANO do header, não "ai"');
  await app.close();
});

test('POST apply guidance_qualified: aplica ai_qualified_guidance', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  seedSuggestion(state, { kind: 'guidance_qualified', payload: { current: null, suggested: 'nova guidance de qualificado', reason: 'r' } });
  const res = await app.inject({ method: 'POST', url: '/whatsapp/suggestions/1/apply', headers, payload: { number_id: 1 } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.settings.ai_qualified_guidance, 'nova guidance de qualificado');
  await app.close();
});

test('POST apply suggestion já resolvida → 409', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  seedSuggestion(state, { status: 'applied', resolved_at: new Date(), resolved_by: 'user-0' });
  const res = await app.inject({ method: 'POST', url: '/whatsapp/suggestions/1/apply', headers, payload: { number_id: 1 } });
  assert.equal(res.statusCode, 409);
  await app.close();
});

test('POST apply id inexistente → 404', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/suggestions/999/apply', headers, payload: { number_id: 1 } });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// ── IMPORTANT B: CAS-first ─────────────────────────────────────────────────────

const numberRow = (id: number, workspaceId: string) => ({
  id, workspace_id: workspaceId, phone: '+5511', evolution_instance: 'i', label: 'N',
  status: 'connected', mode: 'monitored', expose_groups_in_mcp: false, created_by: null,
  created_at: new Date(), updated_at: new Date(), removed_at: null,
});
const pendingSuggestionRow = {
  id: 1, workspace_id: 'ws-1', kind: 'guidance_lead',
  payload: { current: 'antiga', suggested: 'nova', reason: 'r' },
  status: 'pending', created_at: new Date('2026-07-27T10:00:00.000Z'), resolved_at: null, resolved_by: null,
};

test('POST apply: CAS perde a corrida (resolve 0 rows) → 409 SEM tocar settings', async () => {
  // Sugestão pending no load, mas o CAS pending→applied volta 0 rows (um dismiss concorrente
  // resolveu no intervalo). NÃO deve escrever guidance — qualquer SQL de settings estoura.
  let settingsTouched = false;
  const pool = {
    query: async (text: string, params: any[] = []) => {
      if (/FROM whatsapp_numbers WHERE id/.test(text)) return { rows: [numberRow(Number(params[0]), 'ws-1')], rowCount: 1 };
      if (/UPDATE whatsapp_ai_suggestions\s+SET/.test(text)) return { rows: [], rowCount: 0 }; // CAS perdeu
      if (/FROM whatsapp_ai_suggestions/.test(text) && /WHERE id = \$1/.test(text)) return { rows: [pendingSuggestionRow], rowCount: 1 };
      if (/whatsapp_workspace_settings/.test(text)) { settingsTouched = true; return { rows: [], rowCount: 0 }; }
      throw new Error(`unexpected SQL: ${text}`);
    },
  } as any;
  const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/suggestions/1/apply', headers, payload: { number_id: 1 } });
  assert.equal(res.statusCode, 409);
  assert.equal(settingsTouched, false, 'CAS-first: perdeu a corrida → não escreve guidance (estado não mente)');
  await app.close();
});

test('POST apply: CAS ganha mas patchSettings falha → 500 + REVERTE a sugestão pra pending', async () => {
  let reverted = false;
  const pool = {
    query: async (text: string, params: any[] = []) => {
      if (/FROM whatsapp_numbers WHERE id/.test(text)) return { rows: [numberRow(Number(params[0]), 'ws-1')], rowCount: 1 };
      // revert (SET status='pending') — CHECAR ANTES do CAS genérico.
      if (/UPDATE whatsapp_ai_suggestions\s+SET status = 'pending'/.test(text)) { reverted = true; return { rows: [], rowCount: 1 }; }
      // CAS resolve (SET status=$2) ganha.
      if (/UPDATE whatsapp_ai_suggestions\s+SET status = \$2/.test(text)) {
        return { rows: [{ ...pendingSuggestionRow, status: 'applied', resolved_by: params[2], resolved_at: new Date() }], rowCount: 1 };
      }
      if (/FROM whatsapp_ai_suggestions/.test(text) && /WHERE id = \$1/.test(text)) return { rows: [pendingSuggestionRow], rowCount: 1 };
      if (/INSERT INTO whatsapp_workspace_settings/.test(text)) return { rows: [], rowCount: 0 };
      if (/UPDATE whatsapp_workspace_settings SET/.test(text)) throw new Error('patchSettings boom');
      throw new Error(`unexpected SQL: ${text}`);
    },
  } as any;
  const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/suggestions/1/apply', headers, payload: { number_id: 1 } });
  assert.equal(res.statusCode, 500);
  assert.equal(reverted, true, 'patchSettings falhou → revert best-effort pra pending (habilita retry)');
  await app.close();
});

// ── POST /:id/dismiss ─────────────────────────────────────────────────────────────

test('POST dismiss como member não-admin → 403', async () => {
  const { pool, state } = makePool();
  const authz = { assertMember: async () => {}, assertAdmin: async () => { throw new AuthzError('forbidden', 'FORBIDDEN'); } };
  const app = appFor(pool, authz);
  seedSuggestion(state);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/suggestions/1/dismiss', headers, payload: { number_id: 1 } });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST dismiss id de OUTRO workspace → 404', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  seedSuggestion(state, { id: 1, workspace_id: 'ws-2' });
  const res = await app.inject({ method: 'POST', url: '/whatsapp/suggestions/1/dismiss', headers, payload: { number_id: 1 } });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST dismiss pendente → 200, status dismissed, settings intocados', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  seedSuggestion(state);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/suggestions/1/dismiss', headers, payload: { number_id: 1 } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.suggestion.status, 'dismissed');
  assert.equal(body.suggestion.resolved_by, 'user-1');
  assert.equal(state.settings.has('ws-1'), false, 'dismiss não deve criar/tocar settings');
  await app.close();
});

test('POST dismiss já resolvida → 409', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  seedSuggestion(state, { status: 'dismissed', resolved_at: new Date(), resolved_by: 'user-0' });
  const res = await app.inject({ method: 'POST', url: '/whatsapp/suggestions/1/dismiss', headers, payload: { number_id: 1 } });
  assert.equal(res.statusCode, 409);
  await app.close();
});

// ── GET /whatsapp/insights ─────────────────────────────────────────────────────────

test('GET insights sem token → 401', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/insights?number_id=1' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET insights member → 200, últimos N (default 5), mais recente primeiro', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  state.insights.push(
    { id: 1, workspace_id: 'ws-1', run_id: 10, run_at: new Date('2026-07-13T05:00:00.000Z'), summary: 'semana 1', details: null },
    { id: 2, workspace_id: 'ws-1', run_id: 11, run_at: new Date('2026-07-20T05:00:00.000Z'), summary: 'semana 2', details: { tagsCreated: ['x'] } },
    { id: 3, workspace_id: 'ws-2', run_id: 12, run_at: new Date('2026-07-20T05:00:00.000Z'), summary: 'outro workspace', details: null },
  );
  const res = await app.inject({ method: 'GET', url: '/whatsapp/insights?number_id=1', headers });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.insights.length, 2);
  assert.equal(body.insights[0].summary, 'semana 2');
  assert.equal(body.insights[1].summary, 'semana 1');
  await app.close();
});

test('GET insights com limit=1 → respeita o cap', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  state.insights.push(
    { id: 1, workspace_id: 'ws-1', run_id: 10, run_at: new Date('2026-07-13T05:00:00.000Z'), summary: 'semana 1', details: null },
    { id: 2, workspace_id: 'ws-1', run_id: 11, run_at: new Date('2026-07-20T05:00:00.000Z'), summary: 'semana 2', details: null },
  );
  const res = await app.inject({ method: 'GET', url: '/whatsapp/insights?number_id=1&limit=1', headers });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().insights.length, 1);
  await app.close();
});

test('GET insights limit inválido (0) → 400', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/insights?number_id=1&limit=0', headers });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('GET insights limit acima do cap (51) → 400', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/insights?number_id=1&limit=51', headers });
  assert.equal(res.statusCode, 400);
  await app.close();
});
