import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAgentToken } from '../auth.js';
import { getAgentProjectConfig, upsertAgentProjectConfig } from '../db.js';

/**
 * REST por (agent, project). Hoje só serve quiet_hours (Fase 3 da mitigação
 * anti-detecção), expande conforme novos toggles por projeto.
 *
 * Auth: X-Agent-Token. O token precisa pertencer ao agente da URL — agente A
 * não consegue ler/escrever config de agente B.
 */
export async function registerProjectsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAgentToken);

  const ParamsSchema = z.object({
    agent: z.string().min(1),
    project: z.string().min(1),
  });

  app.get('/agents/:agent/projects/:project/config', async (req, reply) => {
    const params = ParamsSchema.parse(req.params);
    if (params.agent !== req.agent.name) {
      return reply.code(403).send({ error: 'token does not match agent in path' });
    }
    const cfg = await getAgentProjectConfig(params.agent, params.project);
    // Devolve defaults sem persistir — GUI tem que dar PATCH explícito pra criar.
    if (!cfg) {
      return {
        agent: params.agent,
        project: params.project,
        quiet_hours_enabled: false,
        quiet_start: '23:00:00',
        quiet_end: '07:00:00',
        quiet_tz: 'America/Sao_Paulo',
        persisted: false,
      };
    }
    return { ...cfg, persisted: true };
  });

  const PatchBody = z
    .object({
      quiet_hours_enabled: z.boolean().optional(),
      quiet_start: z
        .string()
        .regex(/^\d{2}:\d{2}(:\d{2})?$/, 'use HH:MM ou HH:MM:SS')
        .optional(),
      quiet_end: z
        .string()
        .regex(/^\d{2}:\d{2}(:\d{2})?$/, 'use HH:MM ou HH:MM:SS')
        .optional(),
      quiet_tz: z.string().min(1).optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: 'pelo menos 1 campo obrigatório' });

  app.patch('/agents/:agent/projects/:project/config', async (req, reply) => {
    const params = ParamsSchema.parse(req.params);
    if (params.agent !== req.agent.name) {
      return reply.code(403).send({ error: 'token does not match agent in path' });
    }
    const body = PatchBody.parse(req.body);
    const cfg = await upsertAgentProjectConfig({
      agent: params.agent,
      project: params.project,
      ...body,
    });
    return { ...cfg, persisted: true };
  });
}
