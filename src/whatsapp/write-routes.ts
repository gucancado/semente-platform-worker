// src/whatsapp/write-routes.ts
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requirePanelToken } from './provision-routes.js';
import { setLeadStatus } from './thread-meta.js';
import { getNumber } from './numbers.js';
import { defaultRouteAuthz, gateAdmin, type RouteAuthz } from './route-authz.js';
import { logAccess as defaultLogAccess, type LogAccessFn } from './access-log.js';

export function registerWriteRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; panelToken: string; authz?: RouteAuthz; logAccess?: LogAccessFn },
) {
  const authz = deps.authz ?? defaultRouteAuthz;
  const logAccess = deps.logAccess ?? defaultLogAccess;
  const auth = requirePanelToken(deps.panelToken);

  // ── POST /whatsapp/threads/:identifier/lead ──────────────────────────────────
  // NO workspace_id in body; derive workspace from number_id, then assertAdmin (fresh).
  app.post('/whatsapp/threads/:identifier/lead', { preHandler: auth }, async (req: any, reply) => {
    const { number_id, status } = req.body ?? {};
    if (!number_id || (status !== 'lead' && status !== 'not_lead')) return reply.code(400).send({ error: 'number_id e status (lead|not_lead) obrigatórios' });
    // Actor check first (before any DB call).
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const num = await getNumber(deps.pool, Number(number_id));
    if (!num) return reply.code(404).send({ error: 'number not found' });
    if (!await gateAdmin(req, reply, num.workspaceId, authz)) return;
    await setLeadStatus(deps.pool, { numberId: Number(number_id), identifier: req.params.identifier, isLead: status === 'lead', updatedBy: req.actingUser });
    logAccess(deps.pool, { actor: req.actingUser, action: 'set_lead', workspaceId: num.workspaceId, numberId: Number(number_id), identifier: req.params.identifier, meta: { status } });
    return reply.send({ schema: 'whatsapp_v1', ok: true, identifier: req.params.identifier, leadStatus: status });
  });
}
