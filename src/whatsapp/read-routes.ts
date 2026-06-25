import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { listNumbers, getNumber } from './numbers.js';
import { listThreads, listThreadMessages, searchThreads } from './read-queries.js';
import { exportConversation } from './export.js';
import { requirePanelToken } from './provision-routes.js';
import { defaultRouteAuthz, gateMember, type RouteAuthz } from './route-authz.js';
import { logAccess as defaultLogAccess, type LogAccessFn } from './access-log.js';
import { emptyToUndefined } from './query-coerce.js';

export function registerReadRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; panelToken: string; authz?: RouteAuthz; logAccess?: LogAccessFn },
) {
  const authz = deps.authz ?? defaultRouteAuthz;
  const logAccess = deps.logAccess ?? defaultLogAccess;
  const auth = requirePanelToken(deps.panelToken);

  // ── GET /whatsapp/numbers ────────────────────────────────────────────────────
  // workspace_id present in query; listNumbers is workspace-scoped → authz before DB.
  app.get('/whatsapp/numbers', { preHandler: auth }, async (req: any, reply) => {
    const ws = req.query.workspace_id;
    if (!ws) return reply.code(400).send({ error: 'workspace_id required' });
    if (!await gateMember(req, reply, ws, authz)) return;
    const numbers = await listNumbers(deps.pool, ws);
    logAccess(deps.pool, { actor: req.actingUser, action: 'list_numbers', workspaceId: ws });
    return reply.send({ schema: 'whatsapp_v1', numbers });
  });

  // ── GET /whatsapp/threads ────────────────────────────────────────────────────
  // workspace_id + number_id in query; listThreads IS workspace-scoped → authz before DB.
  app.get('/whatsapp/threads', { preHandler: auth }, async (req: any, reply) => {
    const { workspace_id, number_id, limit, cursor, kind, lead_status, lead_stage, lead_source, tag } = req.query;
    if (!workspace_id || !number_id) return reply.code(400).send({ error: 'workspace_id and number_id required' });
    if (Number.isNaN(Number(number_id))) return reply.code(400).send({ error: 'number_id must be numeric' });
    if (!await gateMember(req, reply, workspace_id, authz)) return;
    const k = kind === 'dm' || kind === 'group' ? kind : 'all';
    const ls = lead_status === 'lead' || lead_status === 'not_lead' ? lead_status : 'all';
    const result = await listThreads(deps.pool, {
      workspaceId: workspace_id, numberId: Number(number_id), limit: Number(limit ?? 30), cursor,
      kind: k, leadStatus: ls,
      leadStage: emptyToUndefined(lead_stage),
      leadSource: emptyToUndefined(lead_source),
      tag: emptyToUndefined(tag),
    });
    logAccess(deps.pool, { actor: req.actingUser, action: 'list_threads', workspaceId: workspace_id, numberId: Number(number_id) });
    return reply.send({ schema: 'whatsapp_v1', ...result });
  });

  // ── GET /whatsapp/threads/:identifier/messages ───────────────────────────────
  // NO workspace_id in query; listThreadMessages is NOT workspace-scoped
  // → derive workspace from number_id, then authz.
  app.get('/whatsapp/threads/:identifier/messages', { preHandler: auth }, async (req: any, reply) => {
    const { number_id, limit, cursor } = req.query;
    if (!number_id) return reply.code(400).send({ error: 'number_id required' });
    if (Number.isNaN(Number(number_id))) return reply.code(400).send({ error: 'number_id must be numeric' });
    // Actor check first (before any DB call).
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const num = await getNumber(deps.pool, Number(number_id));
    if (!num) return reply.code(404).send({ error: 'number not found' });
    if (!await gateMember(req, reply, num.workspaceId, authz)) return;
    const result = await listThreadMessages(deps.pool, { workspaceId: num.workspaceId, numberId: Number(number_id), identifier: req.params.identifier, limit: Number(limit ?? 50), cursor });
    logAccess(deps.pool, { actor: req.actingUser, action: 'thread_messages', workspaceId: num.workspaceId, numberId: Number(number_id), identifier: req.params.identifier });
    return reply.send({ schema: 'whatsapp_v1', ...result });
  });

  // ── GET /whatsapp/search ─────────────────────────────────────────────────────
  // workspace_id + number_id in query; searchThreads IS workspace-scoped → authz before DB.
  app.get('/whatsapp/search', { preHandler: auth }, async (req: any, reply) => {
    const { workspace_id, number_id, query, since, until, kind, lead_status, limit, lead_stage, lead_source, tag } = req.query;
    if (!workspace_id || !number_id || !query) return reply.code(400).send({ error: 'workspace_id, number_id e query required' });
    if (Number.isNaN(Number(number_id))) return reply.code(400).send({ error: 'number_id must be numeric' });
    if (!await gateMember(req, reply, workspace_id, authz)) return;
    const k = kind === 'dm' || kind === 'group' ? kind : 'all';
    const ls = lead_status === 'lead' || lead_status === 'not_lead' ? lead_status : 'all';
    const result = await searchThreads(deps.pool, {
      workspaceId: workspace_id, numberId: Number(number_id), query, since, until,
      kind: k, leadStatus: ls, limit: limit ? Number(limit) : undefined,
      leadStage: emptyToUndefined(lead_stage),
      leadSource: emptyToUndefined(lead_source),
      tag: emptyToUndefined(tag),
    });
    logAccess(deps.pool, { actor: req.actingUser, action: 'search', workspaceId: workspace_id, numberId: Number(number_id), meta: { query, count: result.results.length } });
    return reply.send({ schema: 'whatsapp_v1', ...result });
  });

  // ── GET /whatsapp/threads/:identifier/export ─────────────────────────────────
  // exportConversation uses listThreadMessages internally, which is NOT
  // workspace-scoped → derive the AUTHORITATIVE workspace from number_id (NOT the
  // caller-supplied workspace_id), then authz. Otherwise a member of ws A could
  // pass workspace_id=A + a number_id belonging to ws B and exfiltrate B's data.
  app.get('/whatsapp/threads/:identifier/export', { preHandler: auth }, async (req: any, reply) => {
    const { number_id, since, until, max_messages } = req.query;
    if (!number_id) return reply.code(400).send({ error: 'number_id required' });
    if (Number.isNaN(Number(number_id))) return reply.code(400).send({ error: 'number_id must be numeric' });
    // Actor check first (before any DB call).
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const num = await getNumber(deps.pool, Number(number_id));
    if (!num) return reply.code(404).send({ error: 'number not found' });
    if (!await gateMember(req, reply, num.workspaceId, authz)) return;
    const out = await exportConversation(deps.pool, { workspaceId: num.workspaceId, numberId: Number(number_id), identifier: req.params.identifier, since, until, maxMessages: max_messages ? Number(max_messages) : undefined });
    logAccess(deps.pool, { actor: req.actingUser, action: 'export', workspaceId: num.workspaceId, numberId: Number(number_id), identifier: req.params.identifier, meta: { messageCount: out.messageCount } });
    return reply.send({ schema: 'whatsapp_v1', ...out });
  });
}
