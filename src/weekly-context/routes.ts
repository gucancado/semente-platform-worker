/**
 * src/weekly-context/routes.ts — contrato do resumo semanal para o painel.
 * Auth: X-Panel-Token (mesmo padrão das demais rotas do painel).
 *
 *   GET  /weekly-context?workspace_id=   → último resumo bom (ou null)
 *   POST /weekly-context/regenerate {workspace_id}
 *        → regrava o resumo da semana vencida agora (síncrono, ~5 s).
 *          Cooldown de 60 s por workspace (429), para clique repetido não virar
 *          chamada paga repetida. 503 quando o LLM não está configurado.
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requirePanelToken } from '../whatsapp/provision-routes.js';
import type { TextLlm } from '../llm/types.js';
import { dueWeekStart } from './core.js';
import { getLatestWeeklyContext, lastGeneratedAt } from './db.js';
import { generateWeeklyContext } from './service.js';

export const REGENERATE_COOLDOWN_MS = 60_000;

function view(r: Awaited<ReturnType<typeof getLatestWeeklyContext>>) {
  if (!r) return null;
  return {
    week_start: r.week_start,
    status: r.status,
    summary: r.summary,
    model: r.model,
    cost_usd: r.cost_usd,
    generated_at: r.generated_at.toISOString(),
  };
}

export function registerWeeklyContextRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; panelToken: string; llm: TextLlm | null; effort?: 'low' | 'medium' | 'high'; log?: any },
): void {
  const auth = requirePanelToken(deps.panelToken);

  app.get('/weekly-context', { preHandler: auth }, async (req: any, reply) => {
    const ws = req.query?.workspace_id as string | undefined;
    if (!ws) return reply.code(400).send({ error: 'workspace_id_required' });
    return reply.send({ schema: 'weekly_context_v1', context: view(await getLatestWeeklyContext(deps.pool, ws)) });
  });

  app.post('/weekly-context/regenerate', { preHandler: auth }, async (req: any, reply) => {
    const ws = req.body?.workspace_id as string | undefined;
    if (!ws || typeof ws !== 'string') return reply.code(400).send({ error: 'workspace_id_required' });
    if (!deps.llm) return reply.code(503).send({ error: 'llm_not_configured' });
    const week = dueWeekStart(new Date());
    const last = await lastGeneratedAt(deps.pool, ws, week);
    if (last && Date.now() - last.getTime() < REGENERATE_COOLDOWN_MS) {
      return reply.code(429).send({ error: 'cooldown' });
    }
    const by = typeof req.actingUser === 'string' ? req.actingUser : 'panel';
    const r = await generateWeeklyContext({ pool: deps.pool, llm: deps.llm, effort: deps.effort, log: deps.log }, ws, week, by);
    if (r.status === 'failed') return reply.code(502).send({ error: 'generation_failed' });
    return reply.send({ schema: 'weekly_context_v1', context: view(await getLatestWeeklyContext(deps.pool, ws)) });
  });
}
