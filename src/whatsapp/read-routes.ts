import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { listNumbers } from './numbers.js';
import { listThreads, listThreadMessages } from './read-queries.js';
import { requirePanelToken } from './provision-routes.js';

export function registerReadRoutes(app: FastifyInstance, deps: { pool: Pool; panelToken: string }) {
  const auth = requirePanelToken(deps.panelToken);
  app.get('/whatsapp/numbers', { preHandler: auth }, async (req: any, reply) => {
    const ws = req.query.workspace_id;
    if (!ws) return reply.code(400).send({ error: 'workspace_id required' });
    return reply.send({ schema: 'whatsapp_v1', numbers: await listNumbers(deps.pool, ws) });
  });
  app.get('/whatsapp/threads', { preHandler: auth }, async (req: any, reply) => {
    const { workspace_id, number_id, limit, cursor, kind, lead_status } = req.query;
    if (!workspace_id || !number_id) return reply.code(400).send({ error: 'workspace_id and number_id required' });
    const k = kind === 'dm' || kind === 'group' ? kind : 'all';
    const ls = lead_status === 'lead' || lead_status === 'not_lead' ? lead_status : 'all';
    return reply.send({ schema: 'whatsapp_v1', ...await listThreads(deps.pool, { workspaceId: workspace_id, numberId: Number(number_id), limit: Number(limit ?? 30), cursor, kind: k, leadStatus: ls }) });
  });
  app.get('/whatsapp/threads/:identifier/messages', { preHandler: auth }, async (req: any, reply) => {
    const { number_id, limit, cursor } = req.query;
    if (!number_id) return reply.code(400).send({ error: 'number_id required' });
    return reply.send({ schema: 'whatsapp_v1', ...await listThreadMessages(deps.pool, { numberId: Number(number_id), identifier: req.params.identifier, limit: Number(limit ?? 50), cursor }) });
  });
}
