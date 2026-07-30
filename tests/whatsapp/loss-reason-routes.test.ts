import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthzError } from '../../src/whatsapp/authz.js';
import { registerLossReasonRoutes } from '../../src/whatsapp/loss-reason-routes.js';

const TOKEN = 'panel';
const headers = { 'x-panel-token': TOKEN, 'x-acting-user': 'user-1' };
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };

function makePool() {
  const state = {
    reasons: [] as { id: number; workspace_id: string; code: string; label: string; description: string | null; active: boolean }[],
    opportunities: [] as { id: number; workspace_id: string; loss_reason: string | null }[],
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
    if (/SELECT r\.id, r\.code, r\.label, r\.description, r\.active/.test(text)) {
      const workspaceId = params[0];
      const rows = state.reasons.filter(r => r.workspace_id === workspaceId).map(r => ({
        id: r.id, code: r.code, label: r.label, description: r.description, active: r.active,
        usage_count: state.opportunities.filter(o => o.workspace_id === workspaceId && o.loss_reason === r.code).length,
      }));
      return { rows, rowCount: rows.length };
    }
    if (/SELECT loss_reason AS code, COUNT/.test(text)) {
      const [workspaceId, codes] = params;
      const rows = (codes as string[]).map(code => ({
        code, usage_count: state.opportunities.filter(o => o.workspace_id === workspaceId && o.loss_reason === code).length,
      })).filter(r => r.usage_count > 0);
      return { rows, rowCount: rows.length };
    }
    if (/INSERT INTO whatsapp_loss_reasons/.test(text)) {
      const [workspaceId, code] = params;
      if (state.reasons.some(r => r.workspace_id === workspaceId && r.code.toLowerCase() === String(code).toLowerCase())) {
        const error: any = new Error('duplicate'); error.code = '23505'; throw error;
      }
      const row = { id: state.nextId++, workspace_id: params[0], code: params[1], label: params[2],
        description: params[3] ?? null, active: true };
      state.reasons.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/UPDATE whatsapp_loss_reasons SET/.test(text)) {
      const reason = state.reasons.find(r => r.id === Number(params[0]) && r.workspace_id === params[1]);
      if (!reason) return { rows: [], rowCount: 0 };
      const labelMatch = text.match(/label=\$(\d+)/);
      const descriptionMatch = text.match(/description=\$(\d+)/);
      const activeMatch = text.match(/active=\$(\d+)/);
      if (labelMatch) reason.label = params[Number(labelMatch[1]) - 1];
      if (descriptionMatch) reason.description = params[Number(descriptionMatch[1]) - 1];
      if (activeMatch) reason.active = params[Number(activeMatch[1]) - 1];
      else if (/active=FALSE/.test(text)) reason.active = false; // soft-delete literal (deleteLossReason)
      return { rows: [reason], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${text}`);
  };
  return { pool: { query } as any, state };
}

function appFor(pool: any, authz: any = passAuthz) {
  const app = Fastify({ logger: false });
  registerLossReasonRoutes(app, { pool, panelToken: TOKEN, authz, logAccess: () => {} });
  return app;
}

test('GET inclui os 2 motivos de sistema (com usageCount real) + custom, sem nao_lead', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  state.reasons.push({ id: 1, workspace_id: 'ws-1', code: 'sem_orcamento', label: 'Sem orçamento', description: null, active: true });
  state.opportunities.push(
    { id: 1, workspace_id: 'ws-1', loss_reason: 'lead_nao_respondeu' },
    { id: 2, workspace_id: 'ws-1', loss_reason: 'lead_nao_respondeu' },
    { id: 3, workspace_id: 'ws-1', loss_reason: 'sem_orcamento' },
  );
  const res = await app.inject({ method: 'GET', url: '/whatsapp/loss-reasons?number_id=1', headers });
  assert.equal(res.statusCode, 200);
  const { lossReasons } = res.json();
  assert.equal(lossReasons.length, 3);
  const codes = lossReasons.map((r: any) => r.code);
  assert.ok(codes.includes('lead_nao_respondeu'));
  assert.ok(codes.includes('atendente_nao_respondeu'));
  assert.ok(codes.includes('sem_orcamento'));
  assert.ok(!codes.includes('nao_lead'));
  const sistema = lossReasons.find((r: any) => r.code === 'lead_nao_respondeu');
  assert.equal(sistema.system, true);
  assert.equal(sistema.usageCount, 2);
  const custom = lossReasons.find((r: any) => r.code === 'sem_orcamento');
  assert.equal(custom.system, false);
  assert.equal(custom.usageCount, 1);
  await app.close();
});

test('POST cria motivo custom com code slugificado', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/loss-reasons', headers,
    payload: { number_id: 1, label: 'Sem orçamento', description: 'cliente sem verba' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().lossReason.code, 'sem_orcamento');
  assert.equal(res.json().lossReason.system, false);
  await app.close();
});

test('POST colide com código de sistema (label slugifica pra código reservado) → 409', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/loss-reasons', headers,
    payload: { number_id: 1, label: 'Lead não respondeu' } });
  assert.equal(res.statusCode, 409);
  await app.close();
});

test('POST colide com nao_lead (cascata) → 409', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/loss-reasons', headers,
    payload: { number_id: 1, label: 'Não lead' } });
  assert.equal(res.statusCode, 409);
  await app.close();
});

test('POST colide com custom já existente (mesmo code) → 409', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  state.reasons.push({ id: 1, workspace_id: 'ws-1', code: 'sem_orcamento', label: 'Sem orçamento', description: null, active: true });
  const res = await app.inject({ method: 'POST', url: '/whatsapp/loss-reasons', headers,
    payload: { number_id: 1, label: 'sem   orçamento' } });
  assert.equal(res.statusCode, 409);
  await app.close();
});

test('PATCH atualiza label/description/active mas nunca o code', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  state.reasons.push({ id: 1, workspace_id: 'ws-1', code: 'sem_orcamento', label: 'Sem orçamento', description: null, active: true });
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/loss-reasons/1', headers,
    payload: { number_id: 1, label: 'Sem verba', active: false } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().lossReason.code, 'sem_orcamento');
  assert.equal(res.json().lossReason.label, 'Sem verba');
  assert.equal(res.json().lossReason.active, false);
  await app.close();
});

test('PATCH/DELETE de motivo de outro workspace (ou inexistente) retorna 404', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  state.reasons.push({ id: 1, workspace_id: 'ws-2', code: 'sem_orcamento', label: 'Sem orçamento', description: null, active: true });
  assert.equal((await app.inject({ method: 'PATCH', url: '/whatsapp/loss-reasons/1', headers,
    payload: { number_id: 1, label: 'x' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/whatsapp/loss-reasons/1?number_id=1', headers })).statusCode, 404);
  await app.close();
});

test('DELETE faz soft-delete (active=false), id continua existindo', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  state.reasons.push({ id: 1, workspace_id: 'ws-1', code: 'sem_orcamento', label: 'Sem orçamento', description: null, active: true });
  const res = await app.inject({ method: 'DELETE', url: '/whatsapp/loss-reasons/1?number_id=1', headers });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.equal(state.reasons[0].active, false);
  await app.close();
});

test('escrita nao-admin retorna 403', async () => {
  const { pool, state } = makePool();
  state.reasons.push({ id: 1, workspace_id: 'ws-1', code: 'sem_orcamento', label: 'Sem orçamento', description: null, active: true });
  const authz = { assertMember: async () => {}, assertAdmin: async () => { throw new AuthzError('forbidden', 'FORBIDDEN'); } };
  const app = appFor(pool, authz);
  assert.equal((await app.inject({ method: 'POST', url: '/whatsapp/loss-reasons', headers,
    payload: { number_id: 1, label: 'Novo motivo' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: '/whatsapp/loss-reasons/1?number_id=1', headers })).statusCode, 403);
  await app.close();
});
