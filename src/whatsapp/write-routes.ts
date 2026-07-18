// src/whatsapp/write-routes.ts
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requirePanelToken } from './provision-routes.js';
import { setLeadStatus } from './thread-meta.js';
import { getNumber } from './numbers.js';
import { defaultRouteAuthz, gateAdmin, type RouteAuthz } from './route-authz.js';
import { logAccess as defaultLogAccess, type LogAccessFn } from './access-log.js';
import { validateLeadQualifyFields, validateDisqualifyReason, resolveLeadStatus } from './lead-qualify.js';
import { bulkSetLeadStatus, BulkLeadIdentifierError, BULK_LEAD_MAX } from './bulk-lead.js';
import { upsertDisqualifyReason, deactivateDisqualifyReason } from './disqualify-reasons.js';
import { upsertSourceSignal, deactivateSourceSignal } from './source-signals.js';
import { tenantContext } from './tenant-context.js';

/** Validação pura per-item do bulk. Retorna a mensagem de erro (mesma de hoje) ou null. */
function bulkItemError(upd: any, i: number): string | null {
  if (!upd || typeof upd !== 'object') return `updates[${i}]: must be an object`;
  if (typeof upd.identifier !== 'string' || upd.identifier.trim() === '') return `updates[${i}]: identifier is required`;
  const q = validateLeadQualifyFields({ status: upd.status, stage: upd.stage ?? null, disqualifyReason: upd.disqualifyReason ?? null });
  if (q) return `updates[${i}] (${upd.identifier}): ${q}`;
  // Item 6: status opcional — derivado do stage. Valida via resolveLeadStatus.
  const st = resolveLeadStatus(upd.status, upd.stage ?? null);
  if ('error' in st) return `updates[${i}] (${upd.identifier}): ${st.error}`;
  if (upd.tags !== undefined && !(Array.isArray(upd.tags) && upd.tags.every((t: unknown) => typeof t === 'string'))) return `updates[${i}] (${upd.identifier}): tags must be an array of strings`;
  return null;
}

/** Normalise and validate a disqualify-reason code. Returns null when valid; an error string otherwise. */
function normaliseCode(raw: unknown): { code: string } | { error: string } {
  const code = String(raw ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(code)) return { error: 'invalid code: must match /^[a-z0-9_]+$/' };
  return { code };
}

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
    if (number_id === undefined || number_id === null) return reply.code(400).send({ error: 'number_id obrigatório' });
    if (Number.isNaN(Number(number_id))) return reply.code(400).send({ error: 'number_id must be numeric' });
    // Actor check first (before any DB call).
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });

    // ── Pure (no-DB) validation — safe to run before the authz gate (cheap, no info leak).
    // Validate qualification fields (stage whitelist + coherence com status cru).
    const qualifyErr = validateLeadQualifyFields({ status, stage: stage ?? null, disqualifyReason: disqualifyReason ?? null });
    if (qualifyErr) return reply.code(400).send({ error: qualifyErr });

    // Item 6: status é opcional; derivar do stage quando omitido.
    const resolved = resolveLeadStatus(status, stage ?? null);
    if ('error' in resolved) return reply.code(400).send({ error: resolved.error });
    const effectiveStatus = resolved.status;

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
      const valid = await validateDisqualifyReason(deps.pool, num.workspaceId, disqualifyReason);
      if (!valid) return reply.code(400).send({ error: `disqualifyReason '${disqualifyReason}' não encontrado ou inativo` });
    }

    await setLeadStatus(deps.pool, {
      numberId: Number(number_id),
      identifier: req.params.identifier,
      isLead: effectiveStatus === 'lead',
      updatedBy: req.actingUser,
      stage: stage ?? undefined,
      temperature: temperature ?? undefined,
      source: source ?? undefined,
      disqualifyReason: disqualifyReason ?? undefined,
      tags: Array.isArray(tags) ? tags : undefined,
      notes: notes ?? undefined,
    });

    // Observabilidade: logar os campos de qualificação efetivamente recebidos no body
    // (temperature/stage/source/disqualifyReason/tags) torna diagnosticável, pela aba
    // Auditoria, se um "não persistiu" futuro foi o cliente NÃO enviar o campo vs falha
    // de gravação. `notes` fica de fora de propósito (texto livre/PII — minimização LGPD).
    logAccess(deps.pool, { actor: req.actingUser, action: 'set_lead', workspaceId: num.workspaceId, numberId: Number(number_id), identifier: req.params.identifier, meta: { status: effectiveStatus, stage, source, temperature, disqualifyReason, tags } });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), ok: true, identifier: req.params.identifier, leadStatus: effectiveStatus });
  });

  // ── POST /whatsapp/threads/bulk-lead ─────────────────────────────────────────
  // Transactional batch set-lead for many threads at once (admin).
  // mode='strict' (default): all-or-nothing — any item error aborts with 400.
  // mode='partial': item-level errors (invalid field, duplicate, invalid reason,
  //   unknown identifier) are collected into `skipped`; valid items proceed.
  app.post('/whatsapp/threads/bulk-lead', { preHandler: auth }, async (req: any, reply) => {
    const { number_id, updates, mode: rawMode } = req.body ?? {};
    const mode: 'strict' | 'partial' = rawMode === 'partial' ? 'partial' : 'strict';

    // ── 1. Actor (PAYLOAD → 400 nos dois modos) ─────────────────────────────
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });

    // ── 2. Estrutura (PAYLOAD → 400) ────────────────────────────────────────
    if (number_id === undefined || number_id === null) return reply.code(400).send({ error: 'number_id obrigatório' });
    if (Number.isNaN(Number(number_id))) return reply.code(400).send({ error: 'number_id must be numeric' });
    if (!Array.isArray(updates) || updates.length === 0) return reply.code(400).send({ error: 'updates must be a non-empty array' });
    if (updates.length > BULK_LEAD_MAX) return reply.code(400).send({ error: `updates must not exceed ${BULK_LEAD_MAX} items` });

    const skipped: { identifier: string; reason: string }[] = [];

    // ── Pré-passe de duplicatas (conta ocorrências) ─────────────────────────
    const counts = new Map<string, number>();
    for (const u of updates) if (u && typeof u.identifier === 'string') counts.set(u.identifier, (counts.get(u.identifier) ?? 0) + 1);
    const duplicateIds = new Set([...counts].filter(([, c]) => c > 1).map(([id]) => id));

    // ── 3. Validação per-item (ITEM: strict→400, partial→skip) ──────────────
    let candidates: any[] = [];
    for (let i = 0; i < updates.length; i++) {
      const upd = updates[i];
      const err = bulkItemError(upd, i);
      if (err) {
        if (mode === 'strict') return reply.code(400).send({ error: err });
        skipped.push({ identifier: (upd && typeof upd.identifier === 'string') ? upd.identifier : `updates[${i}]`, reason: 'invalid_field' });
        continue;
      }
      if (mode === 'partial' && duplicateIds.has(upd.identifier)) {
        skipped.push({ identifier: upd.identifier, reason: 'duplicate' });
        continue;
      }
      candidates.push(upd);
    }

    // Em strict, duplicatas são rejeitadas APÓS o loop per-item (precedência de erro-de-item preservada).
    if (mode === 'strict' && duplicateIds.size > 0) {
      return reply.code(400).send({ error: 'duplicate identifiers', duplicates: [...duplicateIds] });
    }

    // ── 4. Número + admin gate (PAYLOAD → 404/403) ──────────────────────────
    const num = await getNumber(deps.pool, Number(number_id));
    if (!num) return reply.code(404).send({ error: 'number not found' });
    if (!await gateAdmin(req, reply, num.workspaceId, authz)) return;

    // ── 5. Reasons (ITEM: strict→400, partial→skip) ─────────────────────────
    const reasons = [...new Set(candidates.map((u: any) => u.disqualifyReason).filter((r: unknown): r is string => r != null))];
    if (reasons.length > 0) {
      const { rows } = await deps.pool.query<{ code: string }>(
        `SELECT code FROM whatsapp_disqualify_reasons WHERE code = ANY($1::text[]) AND active = TRUE AND workspace_id = $2`,
        [reasons, num.workspaceId],
      );
      const validReasons = new Set(rows.map((r) => r.code));
      const invalidReasons = reasons.filter((r) => !validReasons.has(r));
      if (invalidReasons.length > 0) {
        if (mode === 'strict') return reply.code(400).send({ error: 'invalid disqualifyReason', invalidReasons });
        const invalidSet = new Set(invalidReasons);
        candidates = candidates.filter((u) => {
          if (u.disqualifyReason != null && invalidSet.has(u.disqualifyReason)) { skipped.push({ identifier: u.identifier, reason: 'invalid_reason' }); return false; }
          return true;
        });
      }
    }

    // ── 6. Guard de subconjunto vazio (partial) ─────────────────────────────
    if (mode === 'partial' && candidates.length === 0) {
      logAccess(deps.pool, { actor: req.actingUser, action: 'set_lead_bulk', workspaceId: num.workspaceId, numberId: Number(number_id), meta: { count: 0, identifiers: [], mode, skippedCount: skipped.length } });
      return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), ok: true, mode: 'partial', updated: 0, identifiers: [], skipped });
    }

    // ── 7. Write transacional ───────────────────────────────────────────────
    let result: { updated: number; identifiers: string[]; skipped: { identifier: string; reason: string }[] };
    try {
      result = await bulkSetLeadStatus(deps.pool, {
        numberId: Number(number_id), workspaceId: num.workspaceId, updatedBy: req.actingUser, mode,
        updates: candidates.map((u: any) => {
          const st = resolveLeadStatus(u.status, u.stage ?? null);
          return {
            identifier: u.identifier,
            status: ('status' in st ? st.status : u.status) as 'lead' | 'not_lead',
            stage: u.stage, temperature: u.temperature, source: u.source,
            disqualifyReason: u.disqualifyReason, tags: Array.isArray(u.tags) ? u.tags : undefined, notes: u.notes,
          };
        }),
      });
    } catch (err) {
      if (err instanceof BulkLeadIdentifierError) return reply.code(400).send({ error: 'identifiers not found', unknownIdentifiers: err.unknownIdentifiers });
      throw err;
    }
    skipped.push(...result.skipped); // unknown_identifier (só em partial)

    const AUDIT_IDENTIFIER_CAP = 200;
    logAccess(deps.pool, {
      actor: req.actingUser, action: 'set_lead_bulk', workspaceId: num.workspaceId, numberId: Number(number_id),
      meta: {
        count: result.updated,
        identifiers: result.identifiers.slice(0, AUDIT_IDENTIFIER_CAP),
        ...(result.identifiers.length > AUDIT_IDENTIFIER_CAP ? { identifiersTruncated: result.identifiers.length - AUDIT_IDENTIFIER_CAP } : {}),
        mode,
        ...(mode === 'partial' ? { skippedCount: skipped.length } : {}),
      },
    });

    const base = { schema: 'whatsapp_v1', context: tenantContext(num), ok: true, updated: result.updated, identifiers: result.identifiers };
    return reply.send(mode === 'partial' ? { ...base, mode: 'partial', skipped } : base);
  });

  // ── POST /whatsapp/disqualify-reasons ────────────────────────────────────────
  // Creates or reactivates a disqualify reason for the workspace. Admin gate.
  app.post('/whatsapp/disqualify-reasons', { preHandler: auth }, async (req: any, reply) => {
    const { workspace_id, code: rawCode, label } = req.body ?? {};
    if (!workspace_id) return reply.code(400).send({ error: 'workspace_id required' });
    if (!label || typeof label !== 'string' || label.trim() === '') {
      return reply.code(400).send({ error: 'label required' });
    }
    const codeResult = normaliseCode(rawCode);
    if ('error' in codeResult) return reply.code(400).send({ error: codeResult.error });
    const { code } = codeResult;
    if (!await gateAdmin(req, reply, workspace_id, authz)) return;
    const { reactivated } = await upsertDisqualifyReason(deps.pool, {
      workspaceId: workspace_id,
      code,
      label: label.trim(),
      createdBy: req.actingUser,
    });
    logAccess(deps.pool, { actor: req.actingUser, action: 'upsert_disqualify_reason', workspaceId: workspace_id, meta: { code, reactivated } });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: workspace_id }), ok: true, reactivated });
  });

  // ── POST /whatsapp/disqualify-reasons/:code/deactivate ───────────────────────
  // Soft-deactivates a disqualify reason. Idempotent. Admin gate.
  app.post('/whatsapp/disqualify-reasons/:code/deactivate', { preHandler: auth }, async (req: any, reply) => {
    const codeResult = normaliseCode(req.params.code);
    if ('error' in codeResult) return reply.code(400).send({ error: codeResult.error });
    const { code } = codeResult;
    const { workspace_id } = req.body ?? {};
    if (!workspace_id) return reply.code(400).send({ error: 'workspace_id required' });
    if (!await gateAdmin(req, reply, workspace_id, authz)) return;
    await deactivateDisqualifyReason(deps.pool, { workspaceId: workspace_id, code });
    logAccess(deps.pool, { actor: req.actingUser, action: 'deactivate_disqualify_reason', workspaceId: workspace_id, meta: { code } });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: workspace_id }), ok: true });
  });

  // ── POST /whatsapp/source-signals ────────────────────────────────────────────
  // Creates or reactivates a source signal for the workspace. Admin gate.
  app.post('/whatsapp/source-signals', { preHandler: auth }, async (req: any, reply) => {
    const { workspace_id, pattern: rawPattern, source: rawSource } = req.body ?? {};
    if (!workspace_id) return reply.code(400).send({ error: 'workspace_id required' });
    if (!rawPattern || typeof rawPattern !== 'string' || rawPattern.trim() === '') {
      return reply.code(400).send({ error: 'pattern required' });
    }
    if (!rawSource || typeof rawSource !== 'string' || rawSource.trim() === '') {
      return reply.code(400).send({ error: 'source required' });
    }
    const pattern = rawPattern.trim();
    const source = rawSource.trim();
    if (!await gateAdmin(req, reply, workspace_id, authz)) return;
    await upsertSourceSignal(deps.pool, { workspaceId: workspace_id, pattern, source });
    logAccess(deps.pool, { actor: req.actingUser, action: 'upsert_source_signal', workspaceId: workspace_id, meta: { pattern, source } });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: workspace_id }), ok: true });
  });

  // ── POST /whatsapp/source-signals/:pattern/deactivate ────────────────────────
  // Soft-deactivates a source signal. Idempotent. Admin gate.
  app.post('/whatsapp/source-signals/:pattern/deactivate', { preHandler: auth }, async (req: any, reply) => {
    const pattern = decodeURIComponent(req.params.pattern);
    const { workspace_id } = req.body ?? {};
    if (!workspace_id) return reply.code(400).send({ error: 'workspace_id required' });
    if (!await gateAdmin(req, reply, workspace_id, authz)) return;
    await deactivateSourceSignal(deps.pool, { workspaceId: workspace_id, pattern });
    logAccess(deps.pool, { actor: req.actingUser, action: 'deactivate_source_signal', workspaceId: workspace_id, meta: { pattern } });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext({ workspaceId: workspace_id }), ok: true });
  });
}
