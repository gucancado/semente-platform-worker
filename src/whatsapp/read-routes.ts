import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { listNumbers, getNumber } from './numbers.js';
import { listThreads, listThreadMessages, searchThreads } from './read-queries.js';
import { exportConversation } from './export.js';
import { requirePanelToken } from './provision-routes.js';
import { defaultRouteAuthz, gateMember, type RouteAuthz } from './route-authz.js';

export function registerReadRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; panelToken: string; authz?: RouteAuthz },
) {
  const authz = deps.authz ?? defaultRouteAuthz;
  const auth = requirePanelToken(deps.panelToken);

  // ── GET /whatsapp/numbers ────────────────────────────────────────────────────
  // workspace_id present in query; listNumbers is workspace-scoped → authz before DB.
  app.get('/whatsapp/numbers', { preHandler: auth }, async (req: any, reply) => {
    const ws = req.query.workspace_id;
    if (!ws) return reply.code(400).send({ error: 'workspace_id required' });
    if (!await gateMember(req, reply, ws, authz)) return;
    return reply.send({ schema: 'whatsapp_v1', numbers: await listNumbers(deps.pool, ws) });
  });

  // ── GET /whatsapp/threads ────────────────────────────────────────────────────
  // workspace_id + number_id in query; listThreads IS workspace-scoped → authz before DB.
  app.get('/whatsapp/threads', { preHandler: auth }, async (req: any, reply) => {
    const { workspace_id, number_id, limit, cursor, kind, lead_status } = req.query;
    if (!workspace_id || !number_id) return reply.code(400).send({ error: 'workspace_id and number_id required' });
    if (!await gateMember(req, reply, workspace_id, authz)) return;
    const k = kind === 'dm' || kind === 'group' ? kind : 'all';
    const ls = lead_status === 'lead' || lead_status === 'not_lead' ? lead_status : 'all';
    return reply.send({ schema: 'whatsapp_v1', ...await listThreads(deps.pool, { workspaceId: workspace_id, numberId: Number(number_id), limit: Number(limit ?? 30), cursor, kind: k, leadStatus: ls }) });
  });

  // ── GET /whatsapp/threads/:identifier/messages ───────────────────────────────
  // NO workspace_id in query; listThreadMessages is NOT workspace-scoped
  // → derive workspace from number_id, then authz.
  app.get('/whatsapp/threads/:identifier/messages', { preHandler: auth }, async (req: any, reply) => {
    const { number_id, limit, cursor } = req.query;
    if (!number_id) return reply.code(400).send({ error: 'number_id required' });
    // Actor check first (before any DB call).
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const num = await getNumber(deps.pool, Number(number_id));
    if (!num) return reply.code(404).send({ error: 'number not found' });
    if (!await gateMember(req, reply, num.workspaceId, authz)) return;
    return reply.send({ schema: 'whatsapp_v1', ...await listThreadMessages(deps.pool, { numberId: Number(number_id), identifier: req.params.identifier, limit: Number(limit ?? 50), cursor }) });
  });

  // ── GET /whatsapp/search ─────────────────────────────────────────────────────
  // workspace_id + number_id in query; searchThreads IS workspace-scoped → authz before DB.
  app.get('/whatsapp/search', { preHandler: auth }, async (req: any, reply) => {
    const { workspace_id, number_id, query, since, until, kind, lead_status, limit } = req.query;
    if (!workspace_id || !number_id || !query) return reply.code(400).send({ error: 'workspace_id, number_id e query required' });
    if (!await gateMember(req, reply, workspace_id, authz)) return;
    const k = kind === 'dm' || kind === 'group' ? kind : 'all';
    const ls = lead_status === 'lead' || lead_status === 'not_lead' ? lead_status : 'all';
    return reply.send({ schema: 'whatsapp_v1', ...await searchThreads(deps.pool, { workspaceId: workspace_id, numberId: Number(number_id), query, since, until, kind: k, leadStatus: ls, limit: limit ? Number(limit) : undefined }) });
  });

  // ── GET /whatsapp/threads/:identifier/export ─────────────────────────────────
  // workspace_id + number_id in query; exportConversation receives workspaceId
  // as a param (scoped) → authz against query's workspace_id before DB.
  app.get('/whatsapp/threads/:identifier/export', { preHandler: auth }, async (req: any, reply) => {
    const { workspace_id, number_id, since, until, max_messages } = req.query;
    if (!workspace_id || !number_id) return reply.code(400).send({ error: 'workspace_id and number_id required' });
    if (!await gateMember(req, reply, workspace_id, authz)) return;
    const out = await exportConversation(deps.pool, { workspaceId: workspace_id, numberId: Number(number_id), identifier: req.params.identifier, since, until, maxMessages: max_messages ? Number(max_messages) : undefined });
    return reply.send({ schema: 'whatsapp_v1', ...out });
  });
}
