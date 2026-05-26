import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOwnerToken } from './auth.js';
import {
  createProject,
  listProjects,
  getProjectBySlug,
  updateProject,
  listGoals,
  listAgendas,
  upsertGoal,
  disableGoal,
} from './db.js';
import {
  ProjectCreateBody,
  ProjectPatchBody,
  ProjectSlugParams,
  GoalUpsertBody,
} from './schemas.js';

export async function registerAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOwnerToken);

  // ── Projects ───────────────────────────────────────────────────────────

  app.post('/admin/agents/:agent/projects', async (req, reply) => {
    const params = ProjectSlugParams.partial({ slug: true }).parse(req.params);
    const body = ProjectCreateBody.parse(req.body);
    try {
      const p = await createProject({
        agent: params.agent,
        slug: body.slug,
        display_name: body.display_name,
      });
      return reply.code(201).send(p);
    } catch (e: any) {
      if (e?.code === '23505') {
        return reply.code(409).send({ error: 'project slug already exists for this agent' });
      }
      throw e;
    }
  });

  app.get('/admin/agents/:agent/projects', async (req) => {
    const params = ProjectSlugParams.partial({ slug: true }).parse(req.params);
    const projects = await listProjects(params.agent);
    return { projects };
  });

  app.get('/admin/agents/:agent/projects/:slug', async (req, reply) => {
    const params = ProjectSlugParams.parse(req.params);
    const project = await getProjectBySlug(params.agent, params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const [goals, agendas] = await Promise.all([listGoals(project.id), listAgendas(project.id)]);
    return { project, goals, agendas };
  });

  app.patch('/admin/agents/:agent/projects/:slug', async (req, reply) => {
    const params = ProjectSlugParams.parse(req.params);
    const body = ProjectPatchBody.parse(req.body);
    const project = await getProjectBySlug(params.agent, params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const updated = await updateProject(project.id, body);
    return updated;
  });

  // ── Goals ──────────────────────────────────────────────────────────────

  app.post('/admin/agents/:agent/projects/:slug/goals', async (req, reply) => {
    const params = ProjectSlugParams.parse(req.params);
    const body = GoalUpsertBody.parse(req.body);
    const project = await getProjectBySlug(params.agent, params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    // Detecta create vs update pra status code
    const existing = await listGoals(project.id);
    const isCreate = !existing.find((g) => g.goal_type === body.goal_type);
    const goal = await upsertGoal({
      project_id: project.id,
      goal_type: body.goal_type,
      enabled: body.enabled,
      config: body.config,
    });
    return reply.code(isCreate ? 201 : 200).send(goal);
  });

  app.delete('/admin/agents/:agent/projects/:slug/goals/:goal_type', async (req, reply) => {
    const params = ProjectSlugParams.extend({ goal_type: z.string().min(1) }).parse(req.params);
    const project = await getProjectBySlug(params.agent, params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    try {
      const goal = await disableGoal(project.id, params.goal_type);
      return goal;
    } catch {
      return reply.code(404).send({ error: 'goal not found' });
    }
  });
}
