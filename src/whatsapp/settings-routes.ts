import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requirePanelToken } from './provision-routes.js';
import { getNumber } from './numbers.js';
import { defaultRouteAuthz, gateAdmin, gateMember, type RouteAuthz } from './route-authz.js';
import { logAccess as defaultLogAccess, type LogAccessFn } from './access-log.js';
import { tenantContext } from './tenant-context.js';
import { getOrCreateSettings, patchSettings, type SettingsPatch, type WorkspaceSettings } from './workspace-settings.js';

const positiveInt = (value: unknown): number | null => {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

// number_id é aceito no body (pra resolver o número/workspace) mas NUNCA vira
// coluna — não entra em PATCHABLE_FIELDS. pipeline_since é read-only e
// deliberadamente NÃO está nesta lista: qualquer body que o inclua cai no ramo
// de "campo desconhecido" abaixo → 400.
const ALLOWED_PATCH_FIELDS = [
  'number_id', 'auto_loss_days', 'new_opp_after_days',
  'ai_engine_enabled', 'ai_lead_guidance', 'ai_qualified_guidance',
];
const PATCHABLE_FIELDS = ALLOWED_PATCH_FIELDS.filter((f) => f !== 'number_id');

export type SettingsPatchValidation =
  | { ok: true; patch: SettingsPatch }
  | { ok: false; error: string };

/**
 * Validação PURA do body do PATCH /whatsapp/settings — sem tocar rede/banco,
 * testável isoladamente. autoLossDays aceita int >= 1 OU null (nullable);
 * newOppAfterDays e aiEngineEnabled NÃO aceitam null (a coluna é NOT NULL).
 */
export function validateSettingsPatch(body: Record<string, unknown>): SettingsPatchValidation {
  const keys = Object.keys(body);
  if (keys.some((key) => !ALLOWED_PATCH_FIELDS.includes(key))) return { ok: false, error: 'invalid patch' };
  if (!keys.some((key) => PATCHABLE_FIELDS.includes(key))) return { ok: false, error: 'invalid patch' };

  const patch: SettingsPatch = {};

  if ('auto_loss_days' in body) {
    const v = body.auto_loss_days;
    if (v === null) {
      patch.autoLossDays = null;
    } else if (typeof v === 'number' && Number.isInteger(v) && v >= 1) {
      patch.autoLossDays = v;
    } else {
      return { ok: false, error: 'invalid auto_loss_days' };
    }
  }
  if ('new_opp_after_days' in body) {
    const v = body.new_opp_after_days;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) {
      patch.newOppAfterDays = v;
    } else {
      return { ok: false, error: 'invalid new_opp_after_days' };
    }
  }
  if ('ai_engine_enabled' in body) {
    const v = body.ai_engine_enabled;
    if (typeof v !== 'boolean') return { ok: false, error: 'invalid ai_engine_enabled' };
    patch.aiEngineEnabled = v;
  }
  if ('ai_lead_guidance' in body) {
    const v = body.ai_lead_guidance;
    if (v !== null && typeof v !== 'string') return { ok: false, error: 'invalid ai_lead_guidance' };
    patch.aiLeadGuidance = v as string | null;
  }
  if ('ai_qualified_guidance' in body) {
    const v = body.ai_qualified_guidance;
    if (v !== null && typeof v !== 'string') return { ok: false, error: 'invalid ai_qualified_guidance' };
    patch.aiQualifiedGuidance = v as string | null;
  }

  return { ok: true, patch };
}

function toWireSettings(s: WorkspaceSettings) {
  return {
    auto_loss_days: s.autoLossDays,
    new_opp_after_days: s.newOppAfterDays,
    ai_engine_enabled: s.aiEngineEnabled,
    ai_lead_guidance: s.aiLeadGuidance,
    ai_qualified_guidance: s.aiQualifiedGuidance,
    pipeline_since: s.pipelineSince,
  };
}

export function registerSettingsRoutes(app: FastifyInstance, deps: {
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

  // Qualquer membro pode LER as settings (mesmo gate de leitura das outras rotas whatsapp_v1).
  app.get('/whatsapp/settings', { preHandler: auth }, async (req: any, reply) => {
    const num = await loadNumber((req.query ?? {}).number_id, reply); if (!num) return;
    if (!await gateMember(req, reply, num.workspaceId, authz)) return;
    const settings = await getOrCreateSettings(deps.pool, num.workspaceId);
    logAccess(deps.pool, { actor: req.actingUser, action: 'get_settings', workspaceId: num.workspaceId, numberId: num.id });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), settings: toWireSettings(settings) });
  });

  // Só admin escreve. pipeline_since é read-only (nunca aceito no body).
  app.patch('/whatsapp/settings', { preHandler: auth }, async (req: any, reply) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const body = req.body ?? {};
    const num = await loadNumber(body.number_id, reply); if (!num) return;
    const validation = validateSettingsPatch(body);
    if (!validation.ok) return reply.code(400).send({ error: validation.error });
    if (!await gateAdmin(req, reply, num.workspaceId, authz)) return;
    // Garante a row antes do UPDATE — workspaces provisionados ANTES desta feature
    // ainda não têm settings (seed histórico é script one-off separado, spec §12.1
    // item 4); sem isso o UPDATE bateria em 0 rows pra eles.
    await getOrCreateSettings(deps.pool, num.workspaceId);
    const settings = await patchSettings(deps.pool, num.workspaceId, validation.patch, req.actingUser);
    logAccess(deps.pool, { actor: req.actingUser, action: 'update_settings', workspaceId: num.workspaceId, numberId: num.id });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), settings: toWireSettings(settings) });
  });
}
