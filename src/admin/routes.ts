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
    const [goals, agendas, conn] = await Promise.all([
      listGoals(project.id),
      listAgendas(project.id),
      getConnectionByProjectId(project.id),
    ]);
    return {
      project,
      goals,
      agendas,
      google_connection: conn ? toPublic(conn) : null,
    };
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

  app.post('/admin/agents/:agent/projects/:slug/google/disconnect', async (req, reply) => {
    const params = ProjectSlugParams.parse(req.params);
    const project = await getProjectBySlug(params.agent, params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const conn = await getConnectionByProjectId(project.id);
    if (!conn) return { ok: true, already_disconnected: true };

    // Tentar revogar o refresh token (swallowed errors — Google pode já ter revogado)
    try {
      const key = loadEncryptionKey();
      const cryptoMod = await import('../integrations/google/crypto.js');
      const refreshToken = cryptoMod.decrypt(conn.refresh_token_encrypted, key);
      await oauthRevoke(refreshToken);
    } catch (e) {
      req.log.warn({ err: e }, 'google revoke failed (continuing with delete)');
    }

    await deleteConnection(project.id);

    req.log.info({
      op: 'admin.google.disconnect',
      agent: params.agent,
      slug: params.slug,
      project_id: project.id,
      acting_user: actingUser(req),
    }, 'admin mutation');

    return { ok: true };
  });

  app.post('/admin/agents/:agent/projects/:slug/google/test', async (req, reply) => {
    const params = ProjectSlugParams.parse(req.params);
    const project = await getProjectBySlug(params.agent, params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const conn = await getConnectionByProjectId(project.id);
    if (!conn) return reply.code(404).send({ error: 'no google connection' });

    // 1. Refresh access token (testa que token ainda é válido)
    try {
      await ensureFreshAccessToken(conn);
    } catch (e) {
      if (e instanceof TokenRevokedError) {
        return reply.code(401).send({ error: 'token_revoked', detail: e.message });
      }
      throw e;
    }

    // 2. Testar Calendar (próprio calendar do agente)
    const calendarResult = await calendarTestAccess(conn, conn.google_email);
    const calendarOk = calendarResult.ok;

    // 3. Testar Gmail (getOwnEmail funciona)
    let gmailOk = false;
    let gmailError: string | undefined;
    try {
      await getOwnEmail(conn);
      gmailOk = true;
    } catch (e) {
      gmailError = (e as Error).message;
    }

    // 4. Verificar scope coverage
    const requiredScopes = [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
    ];
    const scopeWarnings = requiredScopes.filter((s) => !conn.scopes.includes(s));

    req.log.info({
      op: 'admin.google.test',
      agent: params.agent,
      slug: params.slug,
      calendar_ok: calendarOk,
      gmail_ok: gmailOk,
      acting_user: actingUser(req),
    }, 'admin mutation');

    return {
      ok: calendarOk && gmailOk,
      email: conn.google_email,
      calendar_ok: calendarOk,
      calendar_error: calendarOk ? undefined : calendarResult.error,
      gmail_ok: gmailOk,
      gmail_error: gmailError,
      scopes_granted: conn.scopes,
      scope_warnings: scopeWarnings,
    };
  });

  app.post('/admin/agents/:agent/projects/:slug/agendas/:agendaId/test-access', async (req, reply) => {
    const params = ProjectSlugParams.extend({
      agendaId: z.coerce.number().int().positive(),
    }).parse(req.params);
    const project = await getProjectBySlug(params.agent, params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const conn = await getConnectionByProjectId(project.id);
    if (!conn) return reply.code(404).send({ error: 'no google connection' });
    const agenda = await getAgenda(params.agendaId);
    if (!agenda || agenda.project_id !== project.id) {
      return reply.code(404).send({ error: 'agenda not found for this project' });
    }

    const result = await calendarTestAccess(conn, agenda.person_email);

    req.log.info({
      op: 'admin.agenda.test_access',
      agent: params.agent,
      slug: params.slug,
      agenda_id: params.agendaId,
      person_email: agenda.person_email,
      result: result.ok ? 'ok' : result.error,
      acting_user: actingUser(req),
    }, 'admin mutation');

    if (result.ok) {
      return { ok: true, calendar_metadata: result.metadata };
    }
    return {
      ok: false,
      error: result.error,
      detail: result.detail,
      agent_email: conn.google_email,
    };
  });
}
