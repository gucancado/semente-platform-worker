import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requirePanelToken } from './provision-routes.js';
import { getNumber } from './numbers.js';
import { defaultRouteAuthz, gateAdmin, gateMember, type RouteAuthz } from './route-authz.js';
import { logAccess as defaultLogAccess, type LogAccessFn } from './access-log.js';
import { tenantContext } from './tenant-context.js';
import { OppInvariantError, type OppPatch, type OppQualification, type OppStatus } from './opportunity-core.js';
import {
  changeOpportunityTag, conversationExists, createOpportunity, decodeOpportunityCursor,
  deleteOpportunity, getOpportunity, listOpportunities, listOpportunityEvents, patchOpportunity,
} from './opportunities.js';

const statuses = new Set(['em_andamento', 'ganho', 'perdido']);
const qualifications = new Set(['indefinido', 'qualificado', 'desqualificado']);
const positiveInt = (value: unknown): number | null => {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

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
    if (q.qualification !== undefined && !qualifications.has(q.qualification)) return reply.code(400).send({ error: 'invalid qualification' });
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
      status: q.status, qualification: q.qualification, tagId: tagId ?? undefined, identifier: q.identifier,
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
    if (body.qualification !== undefined && !qualifications.has(body.qualification)) return reply.code(400).send({ error: 'invalid qualification' });
    if (body.tag_ids !== undefined && (!Array.isArray(body.tag_ids) || body.tag_ids.some((v: unknown) => !positiveInt(v)))) {
      return reply.code(400).send({ error: 'tag_ids must be an array of ids' });
    }
    const num = await getNumber(deps.pool, numberId);
    if (!num) return reply.code(404).send({ error: 'number not found' });
    if (!await gateAdmin(req, reply, num.workspaceId, authz)) return;
    if (!await conversationExists(deps.pool, { numberId, workspaceId: num.workspaceId, identifier: body.identifier })) {
      return reply.code(404).send({ error: 'conversa não encontrada' });
    }
    const opportunity = await createOpportunity(deps.pool, { numberId, workspaceId: num.workspaceId,
      identifier: body.identifier, title: body.title, qualification: body.qualification,
      tagIds: body.tag_ids?.map(Number), createdBy: req.actingUser });
    if (!opportunity) return reply.code(404).send({ error: 'tag not found' });
    logAccess(deps.pool, { actor: req.actingUser, action: 'create_opportunity', workspaceId: num.workspaceId, numberId, identifier: body.identifier });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), opportunity });
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
    const allowed = ['title', 'status', 'qualification'];
    if (Object.keys(body).some(k => !allowed.includes(k)) || !Object.keys(body).some(k => allowed.includes(k))) return reply.code(400).send({ error: 'invalid patch' });
    if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') return reply.code(400).send({ error: 'invalid title' });
    if (body.status !== undefined && !statuses.has(body.status)) return reply.code(400).send({ error: 'invalid status' });
    if (body.qualification !== undefined && !qualifications.has(body.qualification)) return reply.code(400).send({ error: 'invalid qualification' });
    const loaded = await loadScoped(req, reply); if (!loaded) return;
    if (!await gateAdmin(req, reply, loaded.num.workspaceId, authz)) return;
    try {
      const opportunity = await patchOpportunity(deps.pool, loaded.opp, body as OppPatch, req.actingUser);
      logAccess(deps.pool, { actor: req.actingUser, action: 'update_opportunity', workspaceId: loaded.num.workspaceId, numberId: loaded.num.id, identifier: loaded.opp.identifier });
      return reply.send({ schema: 'whatsapp_v1', context: tenantContext(loaded.num), opportunity });
    } catch (err) {
      if (err instanceof OppInvariantError) return reply.code(err.code === 'desqualificar_ganho' ? 409 : 400).send({ error: err.code });
      throw err;
    }
  });

  app.delete('/whatsapp/opportunities/:id', { preHandler: auth }, async (req: any, reply) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const loaded = await loadScoped(req, reply); if (!loaded) return;
    if (!await gateAdmin(req, reply, loaded.num.workspaceId, authz)) return;
    await deleteOpportunity(deps.pool, loaded.opp.id);
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
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(loaded.num), opportunity });
  };
  app.post('/whatsapp/opportunities/:id/tags', { preHandler: auth }, tagRoute('add'));
  app.delete('/whatsapp/opportunities/:id/tags/:tagId', { preHandler: auth }, tagRoute('remove'));
}
