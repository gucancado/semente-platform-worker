import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requirePanelToken } from './provision-routes.js';
import { getNumber } from './numbers.js';
import { defaultRouteAuthz, gateAdmin, gateMember, type RouteAuthz } from './route-authz.js';
import { logAccess as defaultLogAccess, type LogAccessFn } from './access-log.js';
import { tenantContext } from './tenant-context.js';
import {
  countLossReasonUsage,
  createLossReason,
  deleteLossReason,
  listLossReasons,
  patchLossReason,
  RESERVED_LOSS_REASON_CODES,
  slugifyLossCode,
  SYSTEM_LOSS_REASONS,
} from './loss-reasons.js';

const positiveInt = (value: unknown): number | null => {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const isDuplicate = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';

export function registerLossReasonRoutes(app: FastifyInstance, deps: {
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

  app.get('/whatsapp/loss-reasons', { preHandler: auth }, async (req: any, reply) => {
    const num = await loadNumber((req.query ?? {}).number_id, reply); if (!num) return;
    if (!await gateMember(req, reply, num.workspaceId, authz)) return;
    const systemCodes = SYSTEM_LOSS_REASONS.map(r => r.code);
    const [usage, custom] = await Promise.all([
      countLossReasonUsage(deps.pool, num.workspaceId, systemCodes),
      listLossReasons(deps.pool, num.workspaceId),
    ]);
    const lossReasons = [
      ...SYSTEM_LOSS_REASONS.map(r => ({
        id: null, code: r.code, label: r.label, description: null, active: true,
        usageCount: usage[r.code] ?? 0, system: true,
      })),
      ...custom.map(r => ({ ...r, system: false })),
    ];
    logAccess(deps.pool, { actor: req.actingUser, action: 'list_loss_reasons', workspaceId: num.workspaceId, numberId: num.id });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), lossReasons });
  });

  app.post('/whatsapp/loss-reasons', { preHandler: auth }, async (req: any, reply) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const body = req.body ?? {};
    const num = await loadNumber(body.number_id, reply); if (!num) return;
    if (typeof body.label !== 'string' || !body.label.trim()) return reply.code(400).send({ error: 'label required' });
    const label = body.label.trim();
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      return reply.code(400).send({ error: 'invalid description' });
    }
    const code = slugifyLossCode(label);
    if (!code) return reply.code(400).send({ error: 'label required' });
    if (RESERVED_LOSS_REASON_CODES.has(code)) return reply.code(409).send({ error: 'loss reason code already exists' });
    if (!await gateAdmin(req, reply, num.workspaceId, authz)) return;
    try {
      const lossReason = await createLossReason(deps.pool, {
        workspaceId: num.workspaceId, code, label, description: body.description ?? null, createdBy: req.actingUser,
      });
      logAccess(deps.pool, { actor: req.actingUser, action: 'create_loss_reason', workspaceId: num.workspaceId, numberId: num.id });
      return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), lossReason: { ...lossReason, system: false } });
    } catch (error) {
      if (isDuplicate(error)) return reply.code(409).send({ error: 'loss reason code already exists' });
      throw error;
    }
  });

  app.patch('/whatsapp/loss-reasons/:id', { preHandler: auth }, async (req: any, reply) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const id = positiveInt(req.params.id);
    if (!id) return reply.code(400).send({ error: 'id must be numeric' });
    const body = req.body ?? {};
    const allowed = ['number_id', 'label', 'description', 'active'];
    if (Object.keys(body).some(key => !allowed.includes(key))
      || (body.label === undefined && body.description === undefined && body.active === undefined)) {
      return reply.code(400).send({ error: 'invalid patch' });
    }
    const num = await loadNumber(body.number_id, reply); if (!num) return;
    let label: string | undefined;
    if (body.label !== undefined) {
      if (typeof body.label !== 'string' || !body.label.trim()) return reply.code(400).send({ error: 'invalid label' });
      label = body.label.trim();
    }
    let description: string | null | undefined;
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        return reply.code(400).send({ error: 'invalid description' });
      }
      description = body.description;
    }
    if (body.active !== undefined && typeof body.active !== 'boolean') {
      return reply.code(400).send({ error: 'invalid active' });
    }
    if (!await gateAdmin(req, reply, num.workspaceId, authz)) return;
    const lossReason = await patchLossReason(deps.pool, {
      id, workspaceId: num.workspaceId, label, description, active: body.active, updatedBy: req.actingUser,
    });
    if (!lossReason) return reply.code(404).send({ error: 'loss reason not found' });
    logAccess(deps.pool, { actor: req.actingUser, action: 'update_loss_reason', workspaceId: num.workspaceId, numberId: num.id });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), lossReason: { ...lossReason, system: false } });
  });

  app.delete('/whatsapp/loss-reasons/:id', { preHandler: auth }, async (req: any, reply) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const id = positiveInt(req.params.id);
    if (!id) return reply.code(400).send({ error: 'id must be numeric' });
    const num = await loadNumber((req.query ?? {}).number_id, reply); if (!num) return;
    if (!await gateAdmin(req, reply, num.workspaceId, authz)) return;
    if (!await deleteLossReason(deps.pool, { id, workspaceId: num.workspaceId, updatedBy: req.actingUser })) {
      return reply.code(404).send({ error: 'loss reason not found' });
    }
    logAccess(deps.pool, { actor: req.actingUser, action: 'delete_loss_reason', workspaceId: num.workspaceId, numberId: num.id });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), ok: true });
  });
}
