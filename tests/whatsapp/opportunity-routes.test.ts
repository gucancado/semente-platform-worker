import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AuthzError } from '../../src/whatsapp/authz.js';
import { registerOpportunityRoutes } from '../../src/whatsapp/opportunity-routes.js';

const TOKEN = 'panel';
const headers = { 'x-panel-token': TOKEN, 'x-acting-user': 'user-1' };
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };
const date = (n: number) => new Date(`2026-07-${String(n).padStart(2, '0')}T12:00:00.000Z`);

// ── Mock v3-aware ────────────────────────────────────────────────────────────
// As rotas migraram pro data layer v3 (withConversationLock + createOpportunityV3
// /patchOpportunityV3), então o stub cobre o advisory lock, o INSERT/UPDATE com
// colunas is_qualified/qualification/loss_reason, o side-effect em whatsapp_thread_meta
// (+ _log), o probe de grupo (isGroupThread) e o de motivo de perda (isValidLossReason).
function makePool(opts: {
  conversation?: boolean; group?: boolean; opportunities?: any[]; tags?: any[];
  lossReasons?: { workspace_id: string; code: string; active: boolean }[];
  threadMeta?: Record<string, boolean | null>;
} = {}) {
  const state = {
    opportunities: (opts.opportunities ?? []).map(o => ({ whatsapp_number_id: 1, workspace_id: 'ws-1',
      title: null, status: 'em_andamento', is_qualified: null, qualification: 'indefinido',
      loss_reason: null, created_by: 'user-1', updated_at: o.created_at, closed_at: null, tags: [], ...o })),
    events: [] as any[],
    tags: opts.tags ?? [{ id: 10, workspace_id: 'ws-1', name: 'VIP', color: 'warn' }],
    lossReasons: opts.lossReasons ?? [],
    links: [] as { opportunity_id: number; tag_id: number }[],
    conversation: opts.conversation ?? true,
    group: opts.group ?? false,
    threadMeta: { ...(opts.threadMeta ?? {}) } as Record<string, boolean | null>,
    threadLog: [] as { number_id: number; identifier: string; old_value: string | null; actor: string }[],
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
    if (/pg_advisory_xact_lock/.test(text)) return { rows: [], rowCount: null };
    if (/AS is_group/.test(text)) return { rows: [{ is_group: state.group }], rowCount: 1 };
    if (/SELECT EXISTS/.test(text)) return { rows: [{ exists: state.conversation }], rowCount: 1 };
    if (/SELECT 1 FROM whatsapp_loss_reasons/.test(text)) {
      const found = state.lossReasons.some(r => r.workspace_id === params[0] && r.code === params[1] && r.active);
      return { rows: found ? [{ ok: 1 }] : [], rowCount: found ? 1 : 0 };
    }
    if (/SELECT is_lead FROM whatsapp_thread_meta/.test(text)) {
      const key = `${params[0]}:${params[1]}`;
      return { rows: key in state.threadMeta ? [{ is_lead: state.threadMeta[key] }] : [], rowCount: 0 };
    }
    if (/INSERT INTO whatsapp_thread_meta_log/.test(text)) {
      state.threadLog.push({ number_id: params[0], identifier: params[1], old_value: params[2], actor: params[3] });
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO whatsapp_thread_meta\b/.test(text)) {
      state.threadMeta[`${params[0]}:${params[1]}`] = true; // applyThreadLeadTrue sempre grava TRUE
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO whatsapp_opportunities/.test(text)) {
      const row = { id: state.nextId++, whatsapp_number_id: params[0], workspace_id: params[1],
        identifier: params[2], title: params[3], status: 'em_andamento', is_qualified: params[4],
        qualification: params[5], loss_reason: null, created_by: params[6],
        created_at: date(state.nextId), updated_at: date(state.nextId), closed_at: null, tags: [] };
      state.opportunities.push(row); return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (/INSERT INTO whatsapp_opportunity_events/.test(text)) {
      state.events.push({ id: state.events.length + 1, opportunity_id: params[0], field: params[1],
        old_value: params[2], new_value: params[3], changed_by: params[4], changed_at: date(state.events.length + 1) });
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT whatsapp_number_id, identifier FROM whatsapp_opportunities WHERE id/.test(text)) {
      const o = state.opportunities.find(x => x.id === Number(params[0]));
      return { rows: o ? [{ whatsapp_number_id: o.whatsapp_number_id, identifier: o.identifier }] : [], rowCount: o ? 1 : 0 };
    }
    if (/UPDATE whatsapp_opportunities SET/.test(text)) {
      const o = state.opportunities.find(x => x.id === Number(params[0]));
      if (!o) return { rows: [], rowCount: 0 };
      // v3: SET status=$2, is_qualified=$3, qualification=$4, title=$5, loss_reason=$6, closed_at=...
      o.status = params[1]; o.is_qualified = params[2]; o.qualification = params[3];
      o.title = params[4]; o.loss_reason = params[5]; o.updated_at = date(24);
      if (/closed_at\s*=\s*NOW/.test(text)) o.closed_at = date(24);
      else if (/closed_at\s*=\s*NULL/.test(text)) o.closed_at = null;
      state.updated++; return { rows: [{ id: o.id }], rowCount: 1 };
    }
    if (/SELECT 1 FROM whatsapp_opportunities WHERE id/.test(text)) {
      // re-leitura de existência dentro do lock (deleteOpportunityV3)
      const o = state.opportunities.find(x => x.id === Number(params[0]));
      return { rows: o ? [{ '?column?': 1 }] : [], rowCount: o ? 1 : 0 };
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

// helper: acha a query de LISTAGEM (o SELECT com ORDER BY do listOpportunities)
const listQuery = (state: any) => state.queries.find((q: any) => /ORDER BY date_trunc/.test(q.text))!;

// =============================================================================
// Contrato preservado (semântica das rotas, agora sobre o data layer v3)
// =============================================================================

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
  const { pool } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1), status: 'ganho', is_qualified: true, qualification: 'qualificado' }] });
  const app = appFor(pool); const res = await app.inject({ method: 'PATCH', url: '/whatsapp/opportunities/1', headers, payload: { qualification: 'desqualificado' } });
  assert.equal(res.statusCode, 409); assert.deepEqual(res.json(), { error: 'desqualificar_ganho' }); await app.close();
});

test('PATCH somente title gera só evento title (não toca status/qualification)', async () => {
  const { pool, state } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1) }] }); const app = appFor(pool);
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/opportunities/1', headers, payload: { title: 'Novo' } });
  assert.equal(res.statusCode, 200); assert.equal(res.json().opportunity.title, 'Novo');
  assert.deepEqual(state.events.map(e => e.field), ['title']);
  await app.close();
});

test('PATCH rejeita chave desconhecida (inclui number_id no body)', async () => {
  const { pool } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1) }] }); const app = appFor(pool);
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/opportunities/1', headers, payload: { number_id: 1, title: 'x' } });
  assert.equal(res.statusCode, 400); assert.deepEqual(res.json(), { error: 'invalid patch' }); await app.close();
});

test('DELETE não-admin retorna 403', async () => {
  const { pool } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1) }] });
  const authz = { assertMember: async () => {}, assertAdmin: async () => { throw new AuthzError('forbidden', 'FORBIDDEN'); } };
  const app = appFor(pool, authz); const res = await app.inject({ method: 'DELETE', url: '/whatsapp/opportunities/1', headers });
  assert.equal(res.statusCode, 403); await app.close();
});

test('DELETE admin remove a opp SOB o lock e responde ok', async () => {
  const { pool, state } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1) }] });
  const app = appFor(pool);
  const res = await app.inject({ method: 'DELETE', url: '/whatsapp/opportunities/1', headers });
  assert.equal(res.statusCode, 200); assert.equal(res.json().ok, true);
  assert.equal(state.opportunities.length, 0, 'opp removida');
  // §4.11: o DELETE ocorre DEPOIS de adquirir o advisory lock da conversa.
  const texts = state.queries.map((x: any) => x.text);
  const lockIdx = texts.findIndex((t: string) => /pg_advisory_xact_lock/.test(t));
  const delIdx = texts.findIndex((t: string) => /DELETE FROM whatsapp_opportunities /.test(t));
  assert.ok(lockIdx >= 0 && lockIdx < delIdx, 'DELETE depois do lock');
  await app.close();
});

test('DELETE de id inexistente → 404 (comportamento preservado)', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'DELETE', url: '/whatsapp/opportunities/999', headers });
  assert.equal(res.statusCode, 404); await app.close();
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

// =============================================================================
// v3 — aliases completos is_qualified/qualification + loss_reason + grupo (§10)
// =============================================================================

test('POST alias qualification → is_qualified (qualificado cascateia is_lead=TRUE na thread)', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/opportunities', headers,
    payload: { number_id: 1, identifier: 'a', qualification: 'qualificado' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().opportunity.isQualified, true);
  assert.equal(res.json().opportunity.qualification, 'qualificado');
  assert.equal(state.threadMeta['1:a'], true, 'is_lead cascateado na thread');
  await app.close();
});

test('POST aceita is_qualified booleano direto (true)', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/opportunities', headers,
    payload: { number_id: 1, identifier: 'a', is_qualified: true } });
  assert.equal(res.statusCode, 200); assert.equal(res.json().opportunity.isQualified, true); await app.close();
});

test('POST is_qualified=false → 400 invalid_value (desqualificar é patch, não create)', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/opportunities', headers,
    payload: { number_id: 1, identifier: 'a', is_qualified: false } });
  assert.equal(res.statusCode, 400); assert.deepEqual(res.json(), { error: 'invalid_value' }); await app.close();
});

test('POST alias qualification=desqualificado → 400 invalid_value (mesma regra do false)', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/opportunities', headers,
    payload: { number_id: 1, identifier: 'a', qualification: 'desqualificado' } });
  assert.equal(res.statusCode, 400); assert.deepEqual(res.json(), { error: 'invalid_value' }); await app.close();
});

test('POST is_qualified + qualification divergentes → 400 campos_divergentes', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/opportunities', headers,
    payload: { number_id: 1, identifier: 'a', is_qualified: false, qualification: 'qualificado' } });
  assert.equal(res.statusCode, 400); assert.deepEqual(res.json(), { error: 'campos_divergentes' }); await app.close();
});

test('POST is_qualified + qualification consistentes → ok', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/opportunities', headers,
    payload: { number_id: 1, identifier: 'a', is_qualified: true, qualification: 'qualificado' } });
  assert.equal(res.statusCode, 200); assert.equal(res.json().opportunity.isQualified, true); await app.close();
});

test('POST em thread de GRUPO → 400 grupo_nao_tem_oportunidade', async () => {
  const { pool } = makePool({ group: true }); const app = appFor(pool);
  const res = await app.inject({ method: 'POST', url: '/whatsapp/opportunities', headers,
    payload: { number_id: 1, identifier: 'grp@g.us' } });
  assert.equal(res.statusCode, 400); assert.deepEqual(res.json(), { error: 'grupo_nao_tem_oportunidade' }); await app.close();
});

test('PATCH alias qualification=desqualificado → is_qualified=false (fecha como perdido)', async () => {
  const { pool } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1) }] }); const app = appFor(pool);
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/opportunities/1', headers, payload: { qualification: 'desqualificado' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().opportunity.isQualified, false);
  assert.equal(res.json().opportunity.status, 'perdido');
  await app.close();
});

test('PATCH is_qualified + qualification divergentes → 400 campos_divergentes', async () => {
  const { pool } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1) }] }); const app = appFor(pool);
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/opportunities/1', headers,
    payload: { is_qualified: true, qualification: 'desqualificado' } });
  assert.equal(res.statusCode, 400); assert.deepEqual(res.json(), { error: 'campos_divergentes' }); await app.close();
});

test('PATCH is_qualified=false num ganho → 409 desqualificar_ganho (repassa erro do kernel)', async () => {
  const { pool } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1), status: 'ganho', is_qualified: true, qualification: 'qualificado' }] });
  const app = appFor(pool);
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/opportunities/1', headers, payload: { is_qualified: false } });
  assert.equal(res.statusCode, 409); assert.deepEqual(res.json(), { error: 'desqualificar_ganho' }); await app.close();
});

test('PATCH loss_reason inválido → 400 nomeando o código', async () => {
  const { pool } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1) }] }); const app = appFor(pool);
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/opportunities/1', headers,
    payload: { status: 'perdido', loss_reason: 'motivo_inexistente' } });
  assert.equal(res.statusCode, 400); assert.deepEqual(res.json(), { error: 'loss_reason_invalido', code: 'motivo_inexistente' }); await app.close();
});

test('PATCH loss_reason=nao_lead (cascata) → 400 (nunca aceito de fora)', async () => {
  const { pool } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1) }] }); const app = appFor(pool);
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/opportunities/1', headers,
    payload: { status: 'perdido', loss_reason: 'nao_lead' } });
  assert.equal(res.statusCode, 400); assert.deepEqual(res.json(), { error: 'loss_reason_invalido', code: 'nao_lead' }); await app.close();
});

test('PATCH loss_reason de sistema válido → 200 grava o motivo', async () => {
  const { pool } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1) }] }); const app = appFor(pool);
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/opportunities/1', headers,
    payload: { status: 'perdido', loss_reason: 'lead_nao_respondeu' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().opportunity.status, 'perdido');
  assert.equal(res.json().opportunity.lossReason, 'lead_nao_respondeu');
  await app.close();
});

test('PATCH loss_reason custom ATIVO do workspace → 200', async () => {
  const { pool } = makePool({
    opportunities: [{ id: 1, identifier: 'a', created_at: date(1) }],
    lossReasons: [{ workspace_id: 'ws-1', code: 'sem_orcamento', active: true }],
  });
  const app = appFor(pool);
  const res = await app.inject({ method: 'PATCH', url: '/whatsapp/opportunities/1', headers,
    payload: { status: 'perdido', loss_reason: 'sem_orcamento' } });
  assert.equal(res.statusCode, 200); assert.equal(res.json().opportunity.lossReason, 'sem_orcamento'); await app.close();
});

// =============================================================================
// v3 — GET: filtro is_qualified (string) + alias qualification, resposta dual
// =============================================================================

test('GET filtro is_qualified=true vira o.is_qualified = $ com param true', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/opportunities?number_id=1&is_qualified=true', headers });
  assert.equal(res.statusCode, 200);
  const q = listQuery(state);
  assert.match(q.text, /o\.is_qualified = \$/); assert.ok(q.params.includes(true)); await app.close();
});

test('GET filtro is_qualified=null vira o.is_qualified IS NULL', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/opportunities?number_id=1&is_qualified=null', headers });
  assert.equal(res.statusCode, 200);
  assert.match(listQuery(state).text, /o\.is_qualified IS NULL/); await app.close();
});

test('GET alias qualification=desqualificado vira o.is_qualified = $ com param false', async () => {
  const { pool, state } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/opportunities?number_id=1&qualification=desqualificado', headers });
  assert.equal(res.statusCode, 200);
  const q = listQuery(state);
  assert.match(q.text, /o\.is_qualified = \$/); assert.ok(q.params.includes(false)); await app.close();
});

test('GET is_qualified inválido → 400', async () => {
  const { pool } = makePool(); const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/opportunities?number_id=1&is_qualified=talvez', headers });
  assert.equal(res.statusCode, 400); await app.close();
});

test('GET resposta expõe isQualified, lossReason e qualification derivada', async () => {
  const { pool } = makePool({ opportunities: [{ id: 1, identifier: 'a', created_at: date(1),
    status: 'perdido', is_qualified: false, qualification: 'desqualificado', loss_reason: 'nao_lead' }] });
  const app = appFor(pool);
  const res = await app.inject({ method: 'GET', url: '/whatsapp/opportunities?number_id=1', headers });
  assert.equal(res.statusCode, 200);
  const opp = res.json().opportunities[0];
  assert.equal(opp.isQualified, false);
  assert.equal(opp.lossReason, 'nao_lead');
  assert.equal(opp.qualification, 'desqualificado');
  await app.close();
});
