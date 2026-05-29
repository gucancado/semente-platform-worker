import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
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
  createAgenda,
  getAgenda,
  updateAgenda,
  softDeleteAgenda,
  StaleWriteError,
} from './db.js';
import {
  ProjectCreateBody,
  ProjectPatchBody,
  ProjectSlugParams,
  GoalUpsertBody,
  AgendaCreateBody,
  AgendaPatchBody,
  GoalDisableBody,
} from './schemas.js';

/** Lê X-Acting-User do request. Não autentica — é apenas pra audit trail. */
function actingUser(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const v = req.headers['x-acting-user'];
  if (typeof v === 'string' && v.length > 0 && v.length <= 200) return v;
  return null;
}

export async function registerAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOwnerToken);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'validation failed', issues: err.issues });
    }
    if (err instanceof StaleWriteError) {
      return reply.code(409).send({ error: 'stale write', current: err.current });
    }
    req.log.error({ err }, 'admin route error');
    return reply.code(500).send({ error: 'internal error' });
  });

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
      req.log.info({
        op: 'admin.project.create',
        agent: params.agent,
        slug: body.slug,
        acting_user: actingUser(req),
      }, 'admin mutation');
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
    const updated = await updateProject(project.id, {
      display_name: body.display_name,
      if_match_updated_at: body.if_match_updated_at,
    });
    req.log.info({
      op: 'admin.project.update',
      agent: params.agent,
      slug: params.slug,
      acting_user: actingUser(req),
    }, 'admin mutation');
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
    req.log.info({
      op: 'admin.goal.upsert',
      agent: params.agent,
      slug: params.slug,
      goal_type: body.goal_type,
      acting_user: actingUser(req),
    }, 'admin mutation');
    return reply.code(isCreate ? 201 : 200).send(goal);
  });

  app.delete('/admin/agents/:agent/projects/:slug/goals/:goal_type', async (req, reply) => {
    const params = ProjectSlugParams.extend({ goal_type: z.string().min(1) }).parse(req.params);
    const body = GoalDisableBody.parse(req.body) ?? {};
    const project = await getProjectBySlug(params.agent, params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    try {
      const goal = await disableGoal(project.id, params.goal_type, body.if_match_updated_at);
      req.log.info({
        op: 'admin.goal.disable',
        agent: params.agent,
        slug: params.slug,
        goal_type: params.goal_type,
        acting_user: actingUser(req),
      }, 'admin mutation');
      return goal;
    } catch (e) {
      if (e instanceof StaleWriteError) throw e; // deixa setErrorHandler tratar
      return reply.code(404).send({ error: 'goal not found' });
    }
  });

  // ── Agendas ────────────────────────────────────────────────────────────

  app.post('/admin/agents/:agent/projects/:slug/agendas', async (req, reply) => {
    const params = ProjectSlugParams.parse(req.params);
    const body = AgendaCreateBody.parse(req.body);
    const project = await getProjectBySlug(params.agent, params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const agenda = await createAgenda({
      project_id: project.id,
      person_name: body.person_name,
      person_email: body.person_email,
      display_label: body.display_label,
      description: body.description ?? null,
      working_hours: body.working_hours,
      meeting_duration_min: body.meeting_duration_min,
      min_advance_hours: body.min_advance_hours,
      max_advance_business_days: body.max_advance_business_days,
    });
    req.log.info({
      op: 'admin.agenda.create',
      agent: params.agent,
      slug: params.slug,
      agenda_id: agenda.id,
      acting_user: actingUser(req),
    }, 'admin mutation');
    return reply.code(201).send(agenda);
  });

  app.get('/admin/agents/:agent/projects/:slug/agendas', async (req, reply) => {
    const params = ProjectSlugParams.parse(req.params);
    const project = await getProjectBySlug(params.agent, params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const agendas = await listAgendas(project.id);
    return { agendas };
  });

  app.patch('/admin/agents/:agent/projects/:slug/agendas/:agendaId', async (req, reply) => {
    const params = ProjectSlugParams.extend({
      agendaId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const body = AgendaPatchBody.parse(req.body);
    const project = await getProjectBySlug(params.agent, params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const current = await getAgenda(params.agendaId);
    if (!current || current.project_id !== project.id) {
      return reply.code(404).send({ error: 'agenda not found for this project' });
    }
    const updated = await updateAgenda(params.agendaId, body);
    req.log.info({
      op: 'admin.agenda.update',
      agent: params.agent,
      slug: params.slug,
      agenda_id: params.agendaId,
      acting_user: actingUser(req),
    }, 'admin mutation');
    return updated;
  });

  app.delete('/admin/agents/:agent/projects/:slug/agendas/:agendaId', async (req, reply) => {
    const params = ProjectSlugParams.extend({
      agendaId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const project = await getProjectBySlug(params.agent, params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const current = await getAgenda(params.agendaId);
    if (!current || current.project_id !== project.id) {
      return reply.code(404).send({ error: 'agenda not found for this project' });
    }
    const deleted = await softDeleteAgenda(params.agendaId);
    req.log.info({
      op: 'admin.agenda.deactivate',
      agent: params.agent,
      slug: params.slug,
      agenda_id: params.agendaId,
      acting_user: actingUser(req),
    }, 'admin mutation');
    return deleted;
  });
}
