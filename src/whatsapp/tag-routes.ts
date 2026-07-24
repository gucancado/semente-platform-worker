import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requirePanelToken } from './provision-routes.js';
import { getNumber } from './numbers.js';
import { defaultRouteAuthz, gateAdmin, gateMember, type RouteAuthz } from './route-authz.js';
import { logAccess as defaultLogAccess, type LogAccessFn } from './access-log.js';
import { tenantContext } from './tenant-context.js';
import { normalizeTagName } from './opportunity-core.js';
import { createTag, deleteTag, listTags, patchTag, TAG_COLORS, type TagColor } from './tags.js';

const colors = new Set<string>(TAG_COLORS);
const positiveInt = (value: unknown): number | null => {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const isDuplicate = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';

export function registerTagRoutes(app: FastifyInstance, deps: {
  pool: Pool; panelToken: string; authz?: RouteAuthz; logAccess?: LogAccessFn;
}) {
  const auth = requirePanelToken(deps.panelToken);
  const authz = deps.authz ?? defaultRouteAuthz;
  const logAccess = deps.logAccess ?? defaultLogAccess;

  const loadNumber = async (raw: unknown, reply: any) => {
    if (raw === undefined) { reply.code(400).send({ error: 'number_id required' }); return null; }
    const numberId = positiveInt(raw);
    if (!numberId) { reply.code(400).send({ error: 'number_id must be numeric' }); return null; }
    const num = await getNumber(deps.pool, numberId);
    if (!num) { reply.code(404).send({ error: 'number not found' }); return null; }
    return num;
  };

  app.get('/whatsapp/tags', { preHandler: auth }, async (req: any, reply) => {
    const num = await loadNumber((req.query ?? {}).number_id, reply); if (!num) return;
    if (!await gateMember(req, reply, num.workspaceId, authz)) return;
    const tags = await listTags(deps.pool, num.workspaceId);
    logAccess(deps.pool, { actor: req.actingUser, action: 'list_tags', workspaceId: num.workspaceId, numberId: num.id });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), tags });
  });

  app.post('/whatsapp/tags', { preHandler: auth }, async (req: any, reply) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const body = req.body ?? {};
    const num = await loadNumber(body.number_id, reply); if (!num) return;
    if (typeof body.name !== 'string') return reply.code(400).send({ error: 'invalid name' });
    const name = normalizeTagName(body.name);
    if (!name) return reply.code(400).send({ error: 'name required' });
    if (typeof body.color !== 'string' || !colors.has(body.color)) return reply.code(400).send({ error: 'invalid color' });
    if (!await gateAdmin(req, reply, num.workspaceId, authz)) return;
    try {
      const tag = await createTag(deps.pool, { workspaceId: num.workspaceId, name, color: body.color as TagColor });
      logAccess(deps.pool, { actor: req.actingUser, action: 'create_tag', workspaceId: num.workspaceId, numberId: num.id });
      return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), tag });
    } catch (error) {
      if (isDuplicate(error)) return reply.code(409).send({ error: 'tag name already exists' });
      throw error;
    }
  });

  app.patch('/whatsapp/tags/:id', { preHandler: auth }, async (req: any, reply) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const id = positiveInt(req.params.id);
    if (!id) return reply.code(400).send({ error: 'id must be numeric' });
    const body = req.body ?? {};
    const allowed = ['number_id', 'name', 'color'];
    if (Object.keys(body).some(key => !allowed.includes(key))
      || (body.name === undefined && body.color === undefined)) {
      return reply.code(400).send({ error: 'invalid patch' });
    }
    const num = await loadNumber(body.number_id, reply); if (!num) return;
    let name: string | undefined;
    if (body.name !== undefined) {
      if (typeof body.name !== 'string') return reply.code(400).send({ error: 'invalid name' });
      name = normalizeTagName(body.name) ?? undefined;
      if (!name) return reply.code(400).send({ error: 'name required' });
    }
    if (body.color !== undefined && (typeof body.color !== 'string' || !colors.has(body.color))) {
      return reply.code(400).send({ error: 'invalid color' });
    }
    if (!await gateAdmin(req, reply, num.workspaceId, authz)) return;
    try {
      const tag = await patchTag(deps.pool, { id, workspaceId: num.workspaceId, name,
        color: body.color as TagColor | undefined });
      if (!tag) return reply.code(404).send({ error: 'tag not found' });
      logAccess(deps.pool, { actor: req.actingUser, action: 'update_tag', workspaceId: num.workspaceId, numberId: num.id });
      return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), tag });
    } catch (error) {
      if (isDuplicate(error)) return reply.code(409).send({ error: 'tag name already exists' });
      throw error;
    }
  });

  app.delete('/whatsapp/tags/:id', { preHandler: auth }, async (req: any, reply) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const id = positiveInt(req.params.id);
    if (!id) return reply.code(400).send({ error: 'id must be numeric' });
    const num = await loadNumber((req.query ?? {}).number_id, reply); if (!num) return;
    if (!await gateAdmin(req, reply, num.workspaceId, authz)) return;
    if (!await deleteTag(deps.pool, { id, workspaceId: num.workspaceId })) {
      return reply.code(404).send({ error: 'tag not found' });
    }
    logAccess(deps.pool, { actor: req.actingUser, action: 'delete_tag', workspaceId: num.workspaceId, numberId: num.id });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), ok: true });
  });
}
