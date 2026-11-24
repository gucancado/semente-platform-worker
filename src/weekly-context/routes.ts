/**
 * src/weekly-context/routes.ts — contrato do resumo semanal para o painel.
 * Auth: X-Panel-Token (mesmo padrão das demais rotas do painel).
 *
 *   GET /weekly-context?workspace_id=   → último resumo bom (ou null)
 *
 * Não há geração manual (decisão do Gustavo, 2026-11-24): o resumo só é
 * atualizado pelo poller, toda segunda às 6h (SP).
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requirePanelToken } from '../whatsapp/provision-routes.js';
import { getLatestWeeklyContext } from './db.js';

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

export function registerWeeklyContextRoutes(app: FastifyInstance, deps: { pool: Pool; panelToken: string }): void {
  const auth = requirePanelToken(deps.panelToken);

  app.get('/weekly-context', { preHandler: auth }, async (req: any, reply) => {
    const ws = req.query?.workspace_id as string | undefined;
    if (!ws) return reply.code(400).send({ error: 'workspace_id_required' });
    return reply.send({ schema: 'weekly_context_v1', context: view(await getLatestWeeklyContext(deps.pool, ws)) });
  });
}
