// src/whatsapp/write-routes.ts
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requirePanelToken } from './provision-routes.js';
import { setLeadStatus } from './thread-meta.js';

export function registerWriteRoutes(app: FastifyInstance, deps: { pool: Pool; panelToken: string }) {
  const auth = requirePanelToken(deps.panelToken);
  // O gate de admin é feito no painel (SSO). O worker confia no X-Panel-Token e audita o ator.
  app.post('/whatsapp/threads/:identifier/lead', { preHandler: auth }, async (req: any, reply) => {
    const { number_id, status } = req.body ?? {};
    if (!number_id || (status !== 'lead' && status !== 'not_lead')) return reply.code(400).send({ error: 'number_id e status (lead|not_lead) obrigatórios' });
    await setLeadStatus(deps.pool, { numberId: Number(number_id), identifier: req.params.identifier, isLead: status === 'lead', updatedBy: req.actingUser ?? 'panel' });
    return reply.send({ schema: 'whatsapp_v1', ok: true, identifier: req.params.identifier, leadStatus: status });
  });
}
