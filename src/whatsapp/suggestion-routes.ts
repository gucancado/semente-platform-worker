/**
 * src/whatsapp/suggestion-routes.ts
 *
 * Contrato de LEITURA + APLICAÇÃO das sugestões da IA nível 2 (spec §8 "Não-
 * autonomia" — motor de padrões nunca escreve guidance sozinho, só sugere via
 * `whatsapp_ai_suggestions`, PENDING até um humano decidir) e dos insights
 * semanais (`whatsapp_ai_insights`), Task E4. Molde: loss-reason-routes.ts /
 * settings-routes.ts (mesmo padrão de `loadNumber` por `number_id` + gates).
 *
 * Ordem de POST /:id/apply — DELIBERADA (ver comentário no handler): aplica a
 * guidance via `patchSettings` PRIMEIRO, resolve a sugestão DEPOIS. Se o resolve
 * falhar (crash/timeout entre as duas escritas), a guidance já está aplicada e a
 * sugestão continua 'pending' — um retry do mesmo POST reaplica o MESMO texto
 * (idempotente no efeito) e desta vez o resolve completa. A ordem inversa
 * deixaria uma sugestão 'applied' cuja guidance nunca foi escrita, o que é pior
 * (o painel mostraria "aplicado" sem o efeito real).
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requirePanelToken } from './provision-routes.js';
import { getNumber } from './numbers.js';
import { defaultRouteAuthz, gateAdmin, gateMember, type RouteAuthz } from './route-authz.js';
import { logAccess as defaultLogAccess, type LogAccessFn } from './access-log.js';
import { tenantContext } from './tenant-context.js';
import { getOrCreateSettings, patchSettings, type SettingsPatch, type WorkspaceSettings } from './workspace-settings.js';
import {
  getSuggestion,
  listInsights,
  listPendingSuggestions,
  resolveSuggestion,
  type Insight,
  type Suggestion,
  type SuggestionKind,
} from './ai-pattern-store.js';

const positiveInt = (value: unknown): number | null => {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** kind da sugestão → campo de whatsapp_workspace_settings que ela edita. */
const SUGGESTION_KIND_TO_SETTINGS_FIELD: Record<SuggestionKind, keyof SettingsPatch> = {
  guidance_lead: 'aiLeadGuidance',
  guidance_qualified: 'aiQualifiedGuidance',
};

function toWireSuggestion(s: Suggestion) {
  return {
    id: s.id,
    kind: s.kind,
    payload: s.payload,
    status: s.status,
    created_at: s.createdAt,
    resolved_at: s.resolvedAt,
    resolved_by: s.resolvedBy,
  };
}

function toWireInsight(i: Insight) {
  return {
    id: i.id,
    run_id: i.runId,
    run_at: i.runAt,
    summary: i.summary,
    details: i.details,
  };
}

// Espelha toWireSettings de settings-routes.ts (não exportado de lá — duplicado
// aqui de propósito, é 6 linhas e evita acoplar os dois módulos de rota).
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

export function registerSuggestionRoutes(app: FastifyInstance, deps: {
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

  // Sugestão escopada ao número/workspace do request: 404 tanto pra id inexistente
  // quanto pra id de OUTRO workspace (não vaza existência cross-tenant).
  const loadScopedSuggestion = async (id: number, workspaceId: string, reply: any) => {
    const suggestion = await getSuggestion(deps.pool, id);
    if (!suggestion || suggestion.workspaceId !== workspaceId) {
      reply.code(404).send({ error: 'suggestion not found' });
      return null;
    }
    return suggestion;
  };

  // GET /whatsapp/suggestions?number_id=&status=pending — fila de revisão humana
  // (member lê). `status` só aceita 'pending' hoje (única listagem que o store
  // expõe e a única que a UI consome — sugestões applied/dismissed já saíram
  // da fila e não precisam de uma view própria ainda).
  app.get('/whatsapp/suggestions', { preHandler: auth }, async (req: any, reply) => {
    const query = req.query ?? {};
    const num = await loadNumber(query.number_id, reply); if (!num) return;
    if (query.status !== undefined && query.status !== 'pending') {
      return reply.code(400).send({ error: 'invalid status' });
    }
    if (!await gateMember(req, reply, num.workspaceId, authz)) return;
    const suggestions = await listPendingSuggestions(deps.pool, num.workspaceId);
    logAccess(deps.pool, { actor: req.actingUser, action: 'list_suggestions', workspaceId: num.workspaceId, numberId: num.id });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), suggestions: suggestions.map(toWireSuggestion) });
  });

  // POST /whatsapp/suggestions/:id/apply — admin. Escreve a guidance sugerida via
  // patchSettings COM O ATOR HUMANO do header (não 'ai' — é uma decisão humana de
  // aceitar a sugestão), depois resolve a sugestão como 'applied'. Ver nota de
  // ordem no topo do arquivo.
  app.post('/whatsapp/suggestions/:id/apply', { preHandler: auth }, async (req: any, reply) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const id = positiveInt(req.params.id);
    if (!id) return reply.code(400).send({ error: 'id must be numeric' });
    const body = req.body ?? {};
    const num = await loadNumber(body.number_id, reply); if (!num) return;
    if (!await gateAdmin(req, reply, num.workspaceId, authz)) return;
    const suggestion = await loadScopedSuggestion(id, num.workspaceId, reply); if (!suggestion) return;
    // Já resolvida (applied/dismissed) → conflito. Numa retomada legítima (resolve
    // falhou na tentativa anterior) a sugestão CONTINUA 'pending', então o retry
    // passa por aqui normalmente.
    if (suggestion.status !== 'pending') {
      return reply.code(409).send({ error: 'suggestion already resolved', status: suggestion.status });
    }
    const payload = suggestion.payload as { suggested?: unknown } | null;
    if (typeof payload?.suggested !== 'string') {
      return reply.code(500).send({ error: 'invalid suggestion payload' });
    }
    const field = SUGGESTION_KIND_TO_SETTINGS_FIELD[suggestion.kind];
    // Garante a row antes do UPDATE (mesmo racional de settings-routes.ts): não
    // deveria faltar (guidance vem do runner que já leu settings), mas defensivo.
    await getOrCreateSettings(deps.pool, num.workspaceId);
    const settings = await patchSettings(deps.pool, num.workspaceId, { [field]: payload.suggested } as SettingsPatch, req.actingUser);
    const resolved = await resolveSuggestion(deps.pool, id, 'applied', req.actingUser);
    logAccess(deps.pool, { actor: req.actingUser, action: 'apply_suggestion', workspaceId: num.workspaceId, numberId: num.id });
    if (!resolved) {
      // Corrida perdida ENTRE o check de status acima e este resolve (outro
      // request resolveu primeiro) — a guidance já foi escrita (idempotente:
      // mesmo texto que o vencedor da corrida também teria escrito, já que é o
      // mesmo suggestion.payload). Reporta conflito, mas o settings já refletem
      // o texto sugerido.
      return reply.code(409).send({
        schema: 'whatsapp_v1', context: tenantContext(num),
        error: 'suggestion already resolved', settings: toWireSettings(settings),
      });
    }
    return reply.send({
      schema: 'whatsapp_v1', context: tenantContext(num), applied: true,
      suggestion: toWireSuggestion(resolved), settings: toWireSettings(settings),
    });
  });

  // POST /whatsapp/suggestions/:id/dismiss — admin. Não toca settings.
  app.post('/whatsapp/suggestions/:id/dismiss', { preHandler: auth }, async (req: any, reply) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const id = positiveInt(req.params.id);
    if (!id) return reply.code(400).send({ error: 'id must be numeric' });
    const body = req.body ?? {};
    const num = await loadNumber(body.number_id, reply); if (!num) return;
    if (!await gateAdmin(req, reply, num.workspaceId, authz)) return;
    const suggestion = await loadScopedSuggestion(id, num.workspaceId, reply); if (!suggestion) return;
    const resolved = await resolveSuggestion(deps.pool, id, 'dismissed', req.actingUser);
    if (!resolved) return reply.code(409).send({ error: 'suggestion already resolved' });
    logAccess(deps.pool, { actor: req.actingUser, action: 'dismiss_suggestion', workspaceId: num.workspaceId, numberId: num.id });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), suggestion: toWireSuggestion(resolved) });
  });

  // GET /whatsapp/insights?number_id=&limit=5 — últimos N insights semanais (member lê).
  app.get('/whatsapp/insights', { preHandler: auth }, async (req: any, reply) => {
    const query = req.query ?? {};
    const num = await loadNumber(query.number_id, reply); if (!num) return;
    let limit = 5;
    if (query.limit !== undefined) {
      const parsed = positiveInt(query.limit);
      if (!parsed || parsed > 50) return reply.code(400).send({ error: 'invalid limit' });
      limit = parsed;
    }
    if (!await gateMember(req, reply, num.workspaceId, authz)) return;
    const insights = await listInsights(deps.pool, num.workspaceId, limit);
    logAccess(deps.pool, { actor: req.actingUser, action: 'list_insights', workspaceId: num.workspaceId, numberId: num.id });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), insights: insights.map(toWireInsight) });
  });
}
