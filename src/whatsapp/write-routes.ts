// src/whatsapp/write-routes.ts
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requirePanelToken } from './provision-routes.js';
import { setLeadStatus } from './thread-meta.js';
import { getNumber } from './numbers.js';
import { defaultRouteAuthz, gateAdmin, type RouteAuthz } from './route-authz.js';
import { logAccess as defaultLogAccess, type LogAccessFn } from './access-log.js';
import { validateLeadQualifyFields, validateDisqualifyReason } from './lead-qualify.js';

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
    const { number_id, status, stage, temperature, source, disqualifyReason, tags, notes } = req.body ?? {};
    if (!number_id || (status !== 'lead' && status !== 'not_lead')) return reply.code(400).send({ error: 'number_id e status (lead|not_lead) obrigatórios' });
    if (Number.isNaN(Number(number_id))) return reply.code(400).send({ error: 'number_id must be numeric' });
    // Actor check first (before any DB call).
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });

    // ── Pure (no-DB) validation — safe to run before the authz gate (cheap, no info leak).
    // Validate qualification fields (stage whitelist + coherence).
    const qualifyErr = validateLeadQualifyFields({ status, stage: stage ?? null, disqualifyReason: disqualifyReason ?? null });
    if (qualifyErr) return reply.code(400).send({ error: qualifyErr });

    // `tags`, when present, must be an array of strings. A genuinely omitted `tags`
    // means "don't touch tags"; `[]` means "clear all tags". A non-array (e.g. the
    // string "vendas") is a client error — fail loudly instead of silently ignoring.
    if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === 'string'))) {
      return reply.code(400).send({ error: 'tags must be an array of strings' });
    }

    // ── Number existence + authz gate. DB-backed validation MUST come AFTER the
    // admin gate so a non-admin panel-token holder can't probe reference tables.
    const num = await getNumber(deps.pool, Number(number_id));
    if (!num) return reply.code(404).send({ error: 'number not found' });
    if (!await gateAdmin(req, reply, num.workspaceId, authz)) return;

    // Validate disqualify_reason against DB reference table (if provided) — AFTER authz.
    if (disqualifyReason != null) {
      const valid = await validateDisqualifyReason(deps.pool, disqualifyReason);
      if (!valid) return reply.code(400).send({ error: `disqualifyReason '${disqualifyReason}' não encontrado ou inativo` });
    }

    await setLeadStatus(deps.pool, {
      numberId: Number(number_id),
      identifier: req.params.identifier,
      isLead: status === 'lead',
      updatedBy: req.actingUser,
      stage: stage ?? undefined,
      temperature: temperature ?? undefined,
      source: source ?? undefined,
      disqualifyReason: disqualifyReason ?? undefined,
      tags: Array.isArray(tags) ? tags : undefined,
      notes: notes ?? undefined,
    });

    logAccess(deps.pool, { actor: req.actingUser, action: 'set_lead', workspaceId: num.workspaceId, numberId: Number(number_id), identifier: req.params.identifier, meta: { status, stage, source } });
    return reply.send({ schema: 'whatsapp_v1', ok: true, identifier: req.params.identifier, leadStatus: status });
  });
}
