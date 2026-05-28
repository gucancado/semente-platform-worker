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
} from './db.js';
import {
  ProjectCreateBody,
  ProjectPatchBody,
  ProjectSlugParams,
  GoalUpsertBody,
  AgendaCreateBody,
  AgendaPatchBody,
} from './schemas.js';
import { buildAuthorizeUrl, exchangeCode, revoke as oauthRevoke } from '../integrations/google/oauth.js';
import { encrypt, loadEncryptionKey } from '../integrations/google/crypto.js';
import { upsertConnection, getConnectionByProjectId, deleteConnection } from '../integrations/google/db.js';
import { ensureFreshAccessToken } from '../integrations/google/client-factory.js';
import { testAccess as calendarTestAccess } from '../goals/scheduling/google-calendar.js';
import { getOwnEmail } from '../goals/email/gmail-client.js';
import {
  InvalidStateError,
  TokenRevokedError,
  GoogleApiError,
  toPublic,
} from '../integrations/google/types.js';

function guiBaseUrl(): string {
  return process.env.GUI_BASE_URL ?? 'https://agentes.beeads.com.br';
}

function actingUser(req: import('fastify').FastifyRequest): string {
  const token = req.headers['x-owner-token'];
  return typeof token === 'string' ? token.slice(0, 8) + '…' : 'unknown';
}

export async function registerAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    // Callback público — validado por HMAC no handler
    if (req.url.startsWith('/admin/google-oauth/callback')) return;
    const expected = process.env.OWNER_ADMIN_TOKEN;
    if (!expected) {
      return reply.code(500).send({ error: 'OWNER_ADMIN_TOKEN not configured' });
    }
    const got = req.headers['x-owner-token'];
    if (typeof got !== 'string' || !got) {
      return reply.code(401).send({ error: 'missing X-Owner-Token' });
    }
    if (got !== expected) {
      return reply.code(401).send({ error: 'invalid X-Owner-Token' });
    }
    req.isOwner = true;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'validation failed', issues: err.issues });
    }
    if (err instanceof InvalidStateError) {
      return reply.code(400).send({ error: 'invalid_state', detail: err.message });
    }
    if (err instanceof TokenRevokedError) {
      return reply.code(401).send({ error: 'token_revoked', detail: err.message });
    }
    if (err instanceof GoogleApiError) {
      return reply.code(502).send({ error: 'google_api_error', status: err.status, detail: err.bodyMessage.slice(0, 200) });
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
    return deleted;
  });

  // ── Google OAuth ───────────────────────────────────────────────────────

  app.post('/admin/agents/:agent/projects/:slug/google/oauth-start', async (req, reply) => {
    const params = ProjectSlugParams.parse(req.params);
    const project = await getProjectBySlug(params.agent, params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const returnTo = `/agentes/${params.agent}/projetos/${params.slug}?tab=agendamento`;
    const { url } = buildAuthorizeUrl({ projectId: project.id, returnTo });
    req.log.info({
      op: 'admin.google.oauth_start',
      agent: params.agent,
      slug: params.slug,
      acting_user: actingUser(req),
    }, 'admin mutation');
    return { url };
  });

  app.get('/admin/google-oauth/callback', async (req, reply) => {
    const query = z.object({
      code: z.string().min(1).optional(),
      state: z.string().min(1),
      error: z.string().optional(),
    }).parse(req.query);

    // Se Google retornou ?error=access_denied (user clicou cancelar)
    if (query.error) {
      try {
        const oauth = await import('../integrations/google/oauth.js');
        const payload = oauth._internal.verifyState(query.state, process.env.GOOGLE_OAUTH_STATE_SECRET!);
        return reply.redirect(`${guiBaseUrl()}${payload.return_to}&google=error&reason=${query.error}`);
      } catch {
        return reply.code(400).send({ error: 'oauth denied + invalid state' });
      }
    }

    if (!query.code) return reply.code(400).send({ error: 'missing code' });

    const result = await exchangeCode(query.code, query.state);
    const key = loadEncryptionKey();
    const encrypted = encrypt(result.refresh_token, key);
    await upsertConnection({
      project_id: result.project_id,
      google_email: result.google_email,
      refresh_token_encrypted: encrypted,
      scopes: result.scopes_granted,
    });

    req.log.info({
      op: 'admin.google.oauth_callback',
      project_id: result.project_id,
      google_email: result.google_email,
      scopes_granted: result.scopes_granted,
    }, 'admin mutation');

    return reply.redirect(`${guiBaseUrl()}${result.return_to}&google=connected`);
  });
}
