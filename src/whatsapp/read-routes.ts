import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { listNumbers, getNumber } from './numbers.js';
import { listThreads, listThreadMessages, searchThreads } from './read-queries.js';
import { exportConversation } from './export.js';
import { getStats } from './stats.js';
import { getTimeseries } from './timeseries.js';
import { getFirstResponse } from './first-response.js';
import { listDisqualifyReasons } from './disqualify-reasons.js';
import { listSourceSignals } from './source-signals.js';
import { requirePanelToken } from './provision-routes.js';
import { defaultRouteAuthz, gateMember, gateAdmin, type RouteAuthz } from './route-authz.js';
import { listAccessLog, RELEVANT_ACTIONS } from './audit-queries.js';
import { logAccess as defaultLogAccess, type LogAccessFn } from './access-log.js';
import { emptyToUndefined } from './query-coerce.js';
import { tenantContext } from './tenant-context.js';
import { presignGet, whatsappMediaBucket } from '../integrations/r2.js';

/** Teto de pontos da série de /whatsapp/stats/timeseries (guarda pré-DB). */
const MAX_BUCKETS = 200;

/** Sentinela de `number_id` sintaticamente inválido (≠ "ausente"). */
const INVALID = Symbol('invalid-number-id');

/**
 * Normaliza `?number_id=` das rotas de agregado (stats / stats/timeseries /
 * first-response), onde o param é OPCIONAL e ausente significa "agregue o
 * workspace inteiro".
 *
 * `Number('')` e `Number('  ')` são **0**, não NaN — um guard que só testa
 * `Number.isNaN(Number(v))` deixa passar `?number_id=` (vazio) e manda
 * `whatsapp_number_id = 0` pro SQL, que não casa nada: a rota devolve 200 com o
 * agregado ZERADO em vez do agregado do workspace, em silêncio. É exatamente a
 * classe de bug que o `emptyToUndefined` já previne em since/until/period_basis
 * ("prevents `?lead_stage=` from reaching SQL as `lead_stage = ''`"); só faltava
 * aplicá-lo aqui. Vira ativo assim que um caller (ex.: tool MCP) encaminhar um
 * valor não setado como param vazio.
 *
 * Retorna `undefined` (ausente/vazio → sem filtro por número), `INVALID`
 * (não-numérico → 400) ou o número.
 */
function parseNumberId(raw: unknown): number | undefined | typeof INVALID {
  const v = emptyToUndefined(raw);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? INVALID : n;
}

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
    const inc = typeof req.query.include_removed === 'string' ? req.query.include_removed.toLowerCase() : '';
    const includeRemoved = inc === 'true' || inc === '1' || inc === 'yes';
    const numbers = await listNumbers(deps.pool, ws, { includeRemoved });
    logAccess(deps.pool, { actor: req.actingUser, action: 'list_numbers', workspaceId: ws });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: ws }), numbers });
  });

  // ── GET /whatsapp/threads ────────────────────────────────────────────────────
  // workspace_id + number_id in query; listThreads IS workspace-scoped → authz before DB.
  app.get('/whatsapp/threads', { preHandler: auth }, async (req: any, reply) => {
    const { workspace_id, number_id, limit, cursor, kind, lead_status, lead_stage, lead_source, tag, temperature, include_first_inbound, since, until, period_basis } = req.query;
    if (!workspace_id || !number_id) return reply.code(400).send({ error: 'workspace_id and number_id required' });
    if (Number.isNaN(Number(number_id))) return reply.code(400).send({ error: 'number_id must be numeric' });
    const pb = emptyToUndefined(period_basis);
    if (pb !== undefined && pb !== 'arrival' && pb !== 'activity') {
      return reply.code(400).send({ error: "period_basis must be 'arrival' or 'activity'" });
    }
    const periodBasis = pb as 'arrival' | 'activity' | undefined;
    if (!await gateMember(req, reply, workspace_id, authz)) return;
    const k = kind === 'dm' || kind === 'group' ? kind : 'all';
    const ls = lead_status === 'lead' || lead_status === 'not_lead' ? lead_status : 'all';
    const fib = typeof include_first_inbound === 'string' ? include_first_inbound.toLowerCase() : '';
    const includeFirstInbound = fib === 'true' || fib === '1' || fib === 'yes';
    const result = await listThreads(deps.pool, {
      workspaceId: workspace_id, numberId: Number(number_id), limit: Number(limit ?? 30), cursor,
      kind: k, leadStatus: ls,
      leadStage: emptyToUndefined(lead_stage),
      leadSource: emptyToUndefined(lead_source),
      leadTemperature: emptyToUndefined(temperature),
      tag: emptyToUndefined(tag),
      includeFirstInboundText: includeFirstInbound,
      since: emptyToUndefined(since),
      until: emptyToUndefined(until),
      periodBasis,
    });
    const numForCtx = await getNumber(deps.pool, Number(number_id));
    const ctx = numForCtx && numForCtx.workspaceId === workspace_id
      ? tenantContext(numForCtx) : tenantContext({ workspaceId: workspace_id });
    logAccess(deps.pool, { actor: req.actingUser, action: 'list_threads', workspaceId: workspace_id, numberId: Number(number_id) });
    return reply.send({ schema: 'whatsapp_v1', context: ctx, ...result });
  });

  // ── GET /whatsapp/stats ──────────────────────────────────────────────────────
  // workspace_id required; number_id optional. Member gate (read-only aggregate).
  app.get('/whatsapp/stats', { preHandler: auth }, async (req: any, reply) => {
    const { workspace_id, number_id, since, until, period_basis, kind } = req.query as Record<string, string | undefined>;
    if (!workspace_id) return reply.code(400).send({ error: 'workspace_id required' });
    const nid = parseNumberId(number_id);
    if (nid === INVALID) return reply.code(400).send({ error: 'number_id must be numeric' });
    const pb = emptyToUndefined(period_basis);
    if (pb !== undefined && pb !== 'arrival' && pb !== 'activity') {
      return reply.code(400).send({ error: "period_basis must be 'arrival' or 'activity'" });
    }
    const periodBasis = pb as 'arrival' | 'activity' | undefined;
    if (!await gateMember(req, reply, workspace_id, authz)) return;
    const k = kind === 'dm' || kind === 'group' ? kind : 'all';
    const stats = await getStats(deps.pool, {
      workspaceId: workspace_id,
      numberId: nid,
      since: emptyToUndefined(since),
      until: emptyToUndefined(until),
      periodBasis,
      kind: k,
    });
    let ctx;
    if (nid !== undefined) {
      const numForCtx = await getNumber(deps.pool, nid);
      ctx = numForCtx && numForCtx.workspaceId === workspace_id
        ? tenantContext(numForCtx) : tenantContext({ workspaceId: workspace_id });
    } else {
      ctx = tenantContext({ workspaceId: workspace_id });
    }
    // Omit `meta` entirely: access-log serialises a truthy `{}` to the literal
    // string '{}' instead of NULL. The stats route has no meta payload, so leave
    // it undefined to store NULL like the other reads.
    logAccess(deps.pool, {
      actor: req.actingUser,
      action: 'stats',
      workspaceId: workspace_id,
      numberId: nid ?? null,
    });
    return reply.send({ schema: 'whatsapp_v1', context: ctx, ...stats });
  });

  // ── GET /whatsapp/stats/timeseries ──────────────────────────────────────────
  // Série temporal agregada (sem identifier/texto no payload). Member gate.
  app.get('/whatsapp/stats/timeseries', { preHandler: auth }, async (req: any, reply) => {
    const { workspace_id, number_id, since, until, period_basis, kind, bucket } = req.query as Record<string, string | undefined>;
    if (!workspace_id) return reply.code(400).send({ error: 'workspace_id required' });
    const nid = parseNumberId(number_id);
    if (nid === INVALID) return reply.code(400).send({ error: 'number_id must be numeric' });
    const pb = emptyToUndefined(period_basis);
    if (pb !== undefined && pb !== 'arrival' && pb !== 'activity') {
      return reply.code(400).send({ error: "period_basis must be 'arrival' or 'activity'" });
    }
    const bu = emptyToUndefined(bucket) ?? 'day';
    if (bu !== 'day' && bu !== 'week') {
      return reply.code(400).send({ error: "bucket must be 'day' or 'week'" });
    }
    if (!await gateMember(req, reply, workspace_id, authz)) return;
    const untilEff = emptyToUndefined(until) ?? new Date().toISOString();
    const sinceEff = emptyToUndefined(since) ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const spanMs = new Date(untilEff).getTime() - new Date(sinceEff).getTime();
    if (Number.isNaN(spanMs) || spanMs <= 0) return reply.code(400).send({ error: 'invalid since/until' });
    // Teto de buckets — guarda PRÉ-DB (não montar/trafegar série gigante).
    // A contagem emitida NÃO é span/step: `since`/`until` são INCLUSIVOS e os buckets
    // são alinhados ao fuso SP, então as duas pontas contam — uma janela de exatamente
    // 200 dias emite 201 buckets. Em vez de reintroduzir aritmética de fuso em JS (o
    // SQL é a única autoridade de fuso — ver timeseries.ts), usamos um LIMITE SUPERIOR
    // da contagem: um intervalo de span S cruza no máximo floor(S/step)+1 fronteiras de
    // bucket, logo emite no máximo floor(S/step)+2 buckets. Rejeitar por esse teto
    // garante que a série nunca passa de MAX_BUCKETS (conservador em ~1 na borda).
    const stepMs = bu === 'week' ? 7 * 86_400_000 : 86_400_000;
    if (Math.floor(spanMs / stepMs) + 2 > MAX_BUCKETS) {
      return reply.code(400).send({ error: `window exceeds ${MAX_BUCKETS} buckets` });
    }
    const k = kind === 'dm' || kind === 'group' ? kind : 'all';
    const result = await getTimeseries(deps.pool, {
      workspaceId: workspace_id,
      numberId: nid,
      since: sinceEff, until: untilEff,
      periodBasis: pb as 'arrival' | 'activity' | undefined,
      kind: k, bucket: bu,
    });
    logAccess(deps.pool, { actor: req.actingUser, action: 'stats_timeseries', workspaceId: workspace_id, numberId: nid ?? null });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: workspace_id }), bucket: bu, periodBasis: pb ?? 'arrival', window: { since: sinceEff, until: untilEff }, ...result });
  });

  // ── GET /whatsapp/first-response ────────────────────────────────────────────
  // Tempo de 1ª resposta agregado (live-only, DM por default). Member gate.
  app.get('/whatsapp/first-response', { preHandler: auth }, async (req: any, reply) => {
    const { workspace_id, number_id, since, until, kind } = req.query as Record<string, string | undefined>;
    if (!workspace_id) return reply.code(400).send({ error: 'workspace_id required' });
    const nid = parseNumberId(number_id);
    if (nid === INVALID) return reply.code(400).send({ error: 'number_id must be numeric' });
    if (!await gateMember(req, reply, workspace_id, authz)) return;
    const k = kind === 'dm' || kind === 'group' || kind === 'all' ? kind : 'dm';
    const sinceEff = emptyToUndefined(since) ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = await getFirstResponse(deps.pool, {
      workspaceId: workspace_id,
      numberId: nid,
      since: sinceEff,
      until: emptyToUndefined(until),
      kind: k,
    });
    logAccess(deps.pool, { actor: req.actingUser, action: 'first_response', workspaceId: workspace_id, numberId: nid ?? null });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: workspace_id }), window: { since: sinceEff, until: emptyToUndefined(until) ?? null }, kind: k, ...result });
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
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), ...result });
  });

  // ── GET /whatsapp/media/:messageId ── presign do .ogg (workspace-scoped) ──
  // NO workspace_id in query; the message row carries whatsapp_number_id →
  // derive workspace from there (same pattern as /threads/:identifier/messages).
  app.get('/whatsapp/media/:messageId', { preHandler: auth }, async (req: any, reply) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const messageId = Number(req.params.messageId);
    if (Number.isNaN(messageId)) return reply.code(400).send({ error: 'messageId must be numeric' });
    const { rows } = await deps.pool.query(`SELECT whatsapp_number_id, media_key FROM messages WHERE id=$1`, [messageId]);
    const m = rows[0];
    if (!m || !m.whatsapp_number_id) return reply.code(404).send({ error: 'message not found' });
    const num = await getNumber(deps.pool, Number(m.whatsapp_number_id));
    if (!num) return reply.code(404).send({ error: 'number not found' });
    if (!await gateMember(req, reply, num.workspaceId, authz)) return;
    if (!m.media_key) return reply.code(404).send({ error: 'no media' });
    const url = await presignGet(m.media_key, 120, whatsappMediaBucket()!);
    logAccess(deps.pool, { actor: req.actingUser, action: 'media_presign', workspaceId: num.workspaceId, numberId: num.id });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), url });
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
    const numForCtx = await getNumber(deps.pool, Number(number_id));
    const ctx = numForCtx && numForCtx.workspaceId === workspace_id
      ? tenantContext(numForCtx) : tenantContext({ workspaceId: workspace_id });
    logAccess(deps.pool, { actor: req.actingUser, action: 'search', workspaceId: workspace_id, numberId: Number(number_id), meta: { query, count: result.results.length } });
    return reply.send({ schema: 'whatsapp_v1', context: ctx, ...result });
  });

  // ── GET /whatsapp/disqualify-reasons ─────────────────────────────────────────
  // workspace_id required; workspace-scoped → gateMember before DB.
  app.get('/whatsapp/disqualify-reasons', { preHandler: auth }, async (req: any, reply) => {
    const { workspace_id, include_inactive } = req.query as Record<string, string | undefined>;
    if (!workspace_id) return reply.code(400).send({ error: 'workspace_id required' });
    if (!await gateMember(req, reply, workspace_id, authz)) return;
    const inc = typeof include_inactive === 'string' ? include_inactive.toLowerCase() : '';
    const includeInactive = inc === 'true' || inc === '1' || inc === 'yes';
    const reasons = await listDisqualifyReasons(deps.pool, { workspaceId: workspace_id, includeInactive });
    logAccess(deps.pool, { actor: req.actingUser, action: 'list_disqualify_reasons', workspaceId: workspace_id });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: workspace_id }), reasons });
  });

  // ── GET /whatsapp/source-signals ─────────────────────────────────────────────
  // workspace_id required; workspace-scoped → gateMember before DB.
  app.get('/whatsapp/source-signals', { preHandler: auth }, async (req: any, reply) => {
    const { workspace_id, include_inactive } = req.query as Record<string, string | undefined>;
    if (!workspace_id) return reply.code(400).send({ error: 'workspace_id required' });
    if (!await gateMember(req, reply, workspace_id, authz)) return;
    const inc = typeof include_inactive === 'string' ? ['true', '1', 'yes'].includes(include_inactive.toLowerCase()) : false;
    const signals = await listSourceSignals(deps.pool, { workspaceId: workspace_id, includeInactive: inc });
    logAccess(deps.pool, { actor: req.actingUser, action: 'list_source_signals', workspaceId: workspace_id });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: workspace_id }), signals });
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
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), ...out });
  });

  // ── GET /whatsapp/audit ───────────────────────────────────────────────────────
  // Feed de auditoria (whatsapp_access_log). workspace-scoped. ADMIN-only.
  app.get('/whatsapp/audit', { preHandler: auth }, async (req: any, reply) => {
    const { workspace_id, number_id, actor, scope, since, until, limit, cursor } = req.query as Record<string, string | undefined>;
    if (!workspace_id) return reply.code(400).send({ error: 'workspace_id required' });
    if (number_id !== undefined && Number.isNaN(Number(number_id))) {
      return reply.code(400).send({ error: 'number_id must be numeric' });
    }
    if (limit !== undefined && Number.isNaN(Number(limit))) {
      return reply.code(400).send({ error: 'limit must be numeric' });
    }
    if (!await gateAdmin(req, reply, workspace_id, authz)) return;
    const actions = scope === 'all' ? undefined : [...RELEVANT_ACTIONS];
    const result = await listAccessLog(deps.pool, {
      workspaceId: workspace_id,
      numberId: number_id !== undefined ? Number(number_id) : undefined,
      actor: emptyToUndefined(actor),
      actions,
      since: emptyToUndefined(since),
      until: emptyToUndefined(until),
      limit: Number(limit ?? 50),
      cursor: emptyToUndefined(cursor),
    });
    logAccess(deps.pool, { actor: req.actingUser, action: 'list_audit', workspaceId: workspace_id, numberId: number_id !== undefined ? Number(number_id) : null });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: workspace_id }), ...result });
  });
}
