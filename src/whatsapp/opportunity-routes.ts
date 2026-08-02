import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requirePanelToken } from './provision-routes.js';
import { getNumber } from './numbers.js';
import { defaultRouteAuthz, gateAdmin, gateMember, type RouteAuthz } from './route-authz.js';
import { logAccess as defaultLogAccess, type LogAccessFn } from './access-log.js';
import { tenantContext } from './tenant-context.js';
import { OppInvariantError, type OppPatchV3 } from './opportunity-core.js';
import {
  changeOpportunityTag, conversationExists, createOpportunityV3, decodeOpportunityCursor,
  deleteOpportunityV3, getOpportunity, listOpportunities, listOpportunityEvents, moveOpportunity, patchOpportunityV3,
} from './opportunities.js';
import { isValidLossReason } from './loss-reasons.js';
import { isBoardColumn } from './board.js';
import { isGroupThread } from './thread-meta.js';

const statuses = new Set(['em_andamento', 'ganho', 'perdido']);
const positiveInt = (value: unknown): number | null => {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * Resolve o valor de is_qualified a partir do corpo (v3 contract, mig 053): SÓ
 * `is_qualified` (boolean|null) é aceito. O alias legado `qualification`
 * (string) foi REMOVIDO junto com a coluna — presença da chave é rejeitada com
 * o MESMO erro que antes sinalizava um valor de enum inválido
 * (`invalid qualification`), reusando o 400 existente em vez de introduzir um
 * shape novo. No PATCH esse ramo é redundante com o allowlist de chaves (que já
 * barra `qualification` via 'invalid patch' antes de chegar aqui) — mantido
 * aqui pra o POST, que não tem allowlist, convergir no mesmo comportamento.
 */
type QualResolution =
  | { ok: true; present: boolean; value: boolean | null }
  | { ok: false; error: Record<string, unknown> };
function resolveQualificationInput(body: any): QualResolution {
  if (body.qualification !== undefined) return { ok: false, error: { error: 'invalid qualification' } };
  if (body.is_qualified === undefined) return { ok: true, present: false, value: null };
  if (body.is_qualified !== true && body.is_qualified !== false && body.is_qualified !== null) {
    return { ok: false, error: { error: 'invalid is_qualified' } };
  }
  return { ok: true, present: true, value: body.is_qualified };
}

export function registerOpportunityRoutes(app: FastifyInstance, deps: {
  pool: Pool; panelToken: string; authz?: RouteAuthz; logAccess?: LogAccessFn;
}) {
  const auth = requirePanelToken(deps.panelToken);
  const authz = deps.authz ?? defaultRouteAuthz;
  const logAccess = deps.logAccess ?? defaultLogAccess;

  app.get('/whatsapp/opportunities', { preHandler: auth }, async (req: any, reply) => {
    const q = req.query ?? {};
    const numberId = positiveInt(q.number_id);
    if (q.number_id === undefined) return reply.code(400).send({ error: 'number_id required' });
    if (!numberId) return reply.code(400).send({ error: 'number_id must be numeric' });
    if (q.status !== undefined && !statuses.has(q.status)) return reply.code(400).send({ error: 'invalid status' });
    // v3 contract (mig 053): alias legado `qualification` REMOVIDO — a chave em si
    // (qualquer valor) é rejeitada, reusando o 400 que antes só pegava enum inválido.
    if (q.qualification !== undefined) return reply.code(400).send({ error: 'invalid qualification' });
    // Filtro tri-state v3: is_qualified vem como STRING na query ('true'|'false'|'null').
    let isQualifiedFilter: boolean | null | undefined;
    if (q.is_qualified !== undefined) {
      if (q.is_qualified === 'true') isQualifiedFilter = true;
      else if (q.is_qualified === 'false') isQualifiedFilter = false;
      else if (q.is_qualified === 'null') isQualifiedFilter = null;
      else return reply.code(400).send({ error: 'invalid is_qualified' });
    }
    if (q.identifier !== undefined && typeof q.identifier !== 'string') return reply.code(400).send({ error: 'identifier invalido' });
    const tagId = q.tag_id === undefined ? undefined : positiveInt(q.tag_id);
    if (q.tag_id !== undefined && !tagId) return reply.code(400).send({ error: 'tag_id must be numeric' });
    const rawLimit = q.limit === undefined || q.limit === '' ? 50 : Number(q.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) return reply.code(400).send({ error: 'limit must be between 1 and 200' });
    const cursor = q.cursor === undefined ? undefined : decodeOpportunityCursor(q.cursor);
    if (q.cursor !== undefined && !cursor) return reply.code(400).send({ error: 'invalid cursor' });
    const num = await getNumber(deps.pool, numberId);
    if (!num) return reply.code(404).send({ error: 'number not found' });
    if (!await gateMember(req, reply, num.workspaceId, authz)) return;
    const result = await listOpportunities(deps.pool, { numberId, workspaceId: num.workspaceId,
      status: q.status, isQualified: isQualifiedFilter,
      tagId: tagId ?? undefined, identifier: q.identifier,
      limit: rawLimit, cursor: cursor ?? undefined });
    logAccess(deps.pool, { actor: req.actingUser, action: 'list_opportunities', workspaceId: num.workspaceId, numberId });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), ...result });
  });

  app.post('/whatsapp/opportunities', { preHandler: auth }, async (req: any, reply) => {
    const body = req.body ?? {};
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const numberId = positiveInt(body.number_id);
    if (body.number_id === undefined) return reply.code(400).send({ error: 'number_id required' });
    if (!numberId) return reply.code(400).send({ error: 'number_id must be numeric' });
    if (typeof body.identifier !== 'string' || body.identifier.trim() === '') return reply.code(400).send({ error: 'identifier required' });
    if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') return reply.code(400).send({ error: 'invalid title' });
    const qual = resolveQualificationInput(body);
    if (!qual.ok) return reply.code(400).send(qual.error);
    if (body.tag_ids !== undefined && (!Array.isArray(body.tag_ids) || body.tag_ids.some((v: unknown) => !positiveInt(v)))) {
      return reply.code(400).send({ error: 'tag_ids must be an array of ids' });
    }
    const num = await getNumber(deps.pool, numberId);
    if (!num) return reply.code(404).send({ error: 'number not found' });
    if (!await gateAdmin(req, reply, num.workspaceId, authz)) return;
    // Grupo não tem oportunidade (§10) — reusa a inferência de grupo do listThreads.
    if (await isGroupThread(deps.pool, numberId, body.identifier)) {
      return reply.code(400).send({ error: 'grupo_nao_tem_oportunidade' });
    }
    if (!await conversationExists(deps.pool, { numberId, workspaceId: num.workspaceId, identifier: body.identifier })) {
      return reply.code(404).send({ error: 'conversa não encontrada' });
    }
    try {
      const opportunity = await createOpportunityV3(deps.pool, { numberId, workspaceId: num.workspaceId,
        identifier: body.identifier, title: body.title, isQualified: qual.present ? qual.value : undefined,
        tagIds: body.tag_ids?.map(Number), createdBy: req.actingUser });
      if (!opportunity) return reply.code(404).send({ error: 'tag not found' });
      logAccess(deps.pool, { actor: req.actingUser, action: 'create_opportunity', workspaceId: num.workspaceId, numberId, identifier: body.identifier });
      return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), opportunity });
    } catch (err) {
      // is_qualified=false na criação → invalid_value (desqualificar é patch, não create).
      if (err instanceof OppInvariantError) return reply.code(err.code === 'desqualificar_ganho' ? 409 : 400).send({ error: err.code });
      throw err;
    }
  });

  const loadScoped = async (req: any, reply: any) => {
    const id = positiveInt(req.params.id);
    if (!id) { reply.code(400).send({ error: 'id must be numeric' }); return null; }
    const opp = await getOpportunity(deps.pool, id);
    if (!opp) { reply.code(404).send({ error: 'opportunity not found' }); return null; }
    const num = await getNumber(deps.pool, opp.numberId);
    if (!num || num.workspaceId !== opp.workspaceId) { reply.code(404).send({ error: 'opportunity not found' }); return null; }
    return { opp, num };
  };

  app.patch('/whatsapp/opportunities/:id', { preHandler: auth }, async (req: any, reply) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const body = req.body ?? {};
    // v3 contract (mig 053): `qualification` REMOVIDO do allowlist — presença da
    // chave já cai no 400 'invalid patch' abaixo (mesmo mecanismo de sempre).
    const allowed = ['title', 'status', 'is_qualified', 'loss_reason'];
    if (Object.keys(body).some(k => !allowed.includes(k)) || !Object.keys(body).some(k => allowed.includes(k))) return reply.code(400).send({ error: 'invalid patch' });
    if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') return reply.code(400).send({ error: 'invalid title' });
    if (body.status !== undefined && !statuses.has(body.status)) return reply.code(400).send({ error: 'invalid status' });
    if (body.loss_reason !== undefined && body.loss_reason !== null && typeof body.loss_reason !== 'string') return reply.code(400).send({ error: 'invalid loss_reason' });
    const qual = resolveQualificationInput(body);
    if (!qual.ok) return reply.code(400).send(qual.error);
    const loaded = await loadScoped(req, reply); if (!loaded) return;
    if (!await gateAdmin(req, reply, loaded.num.workspaceId, authz)) return;
    // loss_reason selecionável (sistema ∪ custom ativo); nunca a cascata 'nao_lead'.
    if (typeof body.loss_reason === 'string'
      && !await isValidLossReason(deps.pool, loaded.num.workspaceId, body.loss_reason)) {
      return reply.code(400).send({ error: 'loss_reason_invalido', code: body.loss_reason });
    }
    const patch: OppPatchV3 = {};
    if (body.status !== undefined) patch.status = body.status;
    if (body.title !== undefined) patch.title = body.title;
    if (qual.present) patch.isQualified = qual.value;
    if (body.loss_reason !== undefined) patch.lossReason = body.loss_reason;
    const result = await patchOpportunityV3(deps.pool, loaded.opp.id, patch, req.actingUser);
    if (!result.ok) {
      const code = result.error === 'not_found' ? 404 : result.error === 'desqualificar_ganho' ? 409 : 400;
      return reply.code(code).send({ error: result.error });
    }
    logAccess(deps.pool, { actor: req.actingUser, action: 'update_opportunity', workspaceId: loaded.num.workspaceId, numberId: loaded.num.id, identifier: loaded.opp.identifier });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(loaded.num), opportunity: result.opportunity });
  });

  // POST /whatsapp/opportunities/:id/move — DnD do kanban (§5/§10): 1 chamada que
  // executa a transição de coluna inteira (opp + thread + eventos) numa transação
  // sob o lock. body {column}; as 4 colunas são vivas (mover pra qualquer uma reabre
  // uma opp perdida). Perder saiu do board (é patch pela conversa) → `loss_reason` não
  // é mais aceito aqui: se vier no body, 400 explícito (body estrito, não ignora).
  app.post('/whatsapp/opportunities/:id/move', { preHandler: auth }, async (req: any, reply) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const body = req.body ?? {};
    if (!isBoardColumn(body.column)) return reply.code(400).send({ error: 'invalid column' });
    const column = body.column;
    // loss_reason saiu do contrato do move (perder = patch pela conversa) → rejeita
    // explicitamente em vez de ignorar em silêncio.
    if (body.loss_reason !== undefined) return reply.code(400).send({ error: 'loss_reason_nao_aceito' });
    const loaded = await loadScoped(req, reply); if (!loaded) return;
    if (!await gateAdmin(req, reply, loaded.num.workspaceId, authz)) return;
    const result = await moveOpportunity(deps.pool, loaded.opp.id, column, req.actingUser);
    if (!result.ok) {
      const code = result.error === 'not_found' ? 404 : result.error === 'desqualificar_ganho' ? 409 : 400;
      return reply.code(code).send({ error: result.error });
    }
    logAccess(deps.pool, { actor: req.actingUser, action: 'move_opportunity', workspaceId: loaded.num.workspaceId, numberId: loaded.num.id, identifier: loaded.opp.identifier });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(loaded.num),
      opportunity: result.opportunity, column: result.column, moved: result.moved });
  });

  app.delete('/whatsapp/opportunities/:id', { preHandler: auth }, async (req: any, reply) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const loaded = await loadScoped(req, reply); if (!loaded) return;
    if (!await gateAdmin(req, reply, loaded.num.workspaceId, authz)) return;
    // DELETE sob o lock da conversa (§4.11); id que sumiu entre o loadScoped e o
    // lock → 404 (mesmo código do id inexistente que o loadScoped já devolve).
    const result = await deleteOpportunityV3(deps.pool, loaded.opp.id);
    if (!result.ok) return reply.code(404).send({ error: result.error });
    logAccess(deps.pool, { actor: req.actingUser, action: 'delete_opportunity', workspaceId: loaded.num.workspaceId, numberId: loaded.num.id, identifier: loaded.opp.identifier });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(loaded.num), ok: true });
  });

  app.get('/whatsapp/opportunities/:id/events', { preHandler: auth }, async (req: any, reply) => {
    const loaded = await loadScoped(req, reply); if (!loaded) return;
    if (!await gateMember(req, reply, loaded.num.workspaceId, authz)) return;
    const events = await listOpportunityEvents(deps.pool, loaded.opp.id);
    logAccess(deps.pool, { actor: req.actingUser, action: 'list_opportunity_events', workspaceId: loaded.num.workspaceId, numberId: loaded.num.id, identifier: loaded.opp.identifier });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(loaded.num), events });
  });

  const tagRoute = (action: 'add' | 'remove') => async (req: any, reply: any) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const rawTag = action === 'add' ? (req.body ?? {}).tag_id : req.params.tagId;
    const tagId = positiveInt(rawTag);
    if (!tagId) return reply.code(400).send({ error: 'tag_id must be numeric' });
    const loaded = await loadScoped(req, reply); if (!loaded) return;
    if (!await gateAdmin(req, reply, loaded.num.workspaceId, authz)) return;
    const result = await changeOpportunityTag(deps.pool, { opportunityId: loaded.opp.id,
      workspaceId: loaded.num.workspaceId, tagId, changedBy: req.actingUser, action });
    if (!result.found) return reply.code(404).send({ error: 'tag not found' });
    const opportunity = await getOpportunity(deps.pool, loaded.opp.id);
    logAccess(deps.pool, { actor: req.actingUser, action: action === 'add' ? 'add_opportunity_tag' : 'remove_opportunity_tag',
      workspaceId: loaded.num.workspaceId, numberId: loaded.num.id, identifier: loaded.opp.identifier });
    const { numberId: _numberId, workspaceId: _workspaceId, ...publicOpportunity } = opportunity!;
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(loaded.num), opportunity: publicOpportunity });
  };
  app.post('/whatsapp/opportunities/:id/tags', { preHandler: auth }, tagRoute('add'));
  app.delete('/whatsapp/opportunities/:id/tags/:tagId', { preHandler: auth }, tagRoute('remove'));
}
