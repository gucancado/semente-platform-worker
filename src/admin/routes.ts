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
import { buildAuthorizeUrl, exchangeCode, revoke as oauthRevoke } from '../integrations/google/oauth.js';
import { encrypt, loadEncryptionKey } from '../integrations/google/crypto.js';
import { upsertConnection, getConnectionByProjectId, deleteConnection } from '../integrations/google/db.js';
import { ensureFreshAccessToken } from '../integrations/google/client-factory.js';
import { testAccess as calendarTestAccess, listCalendars } from '../goals/scheduling/google-calendar.js';
import { getOwnEmail } from '../goals/email/gmail-client.js';
import {
  InvalidStateError,
  TokenRevokedError,
  GoogleApiError,
  toPublic,
  REQUIRED_SCOPES,
} from '../integrations/google/types.js';

function guiBaseUrl(): string {
  return process.env.GUI_BASE_URL ?? 'https://agentes.beeads.com.br';
}

/** Lê X-Acting-User do request. Não autentica — é apenas pra audit trail. */
function actingUser(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const v = req.headers['x-acting-user'];
  if (typeof v === 'string' && v.length > 0 && v.length <= 200) return v;
  return null;
}

export async function registerAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    // Callback público — validado por HMAC no handler
    if (req.url.startsWith('/admin/google/callback')) return;
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
    if (err instanceof StaleWriteError) {
      return reply.code(409).send({ error: 'stale write', current: err.current });
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

  app.get('/admin/google/callback', async (req, reply) => {
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

  // Lista calendars acessíveis pela conexão OAuth do projeto.
  // Usado pela GUI pra mostrar dropdown de seleção em vez de campo de texto livre.
  app.get('/admin/agents/:agent/projects/:slug/google/calendars', async (req, reply) => {
    const params = ProjectSlugParams.parse(req.params);
    const project = await getProjectBySlug(params.agent, params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const conn = await getConnectionByProjectId(project.id);
    if (!conn) return reply.code(404).send({ error: 'no google connection' });
    try {
      await ensureFreshAccessToken(conn);
    } catch (e) {
      if (e instanceof TokenRevokedError) {
        return reply.code(401).send({ error: 'token_revoked', detail: e.message });
      }
      throw e;
    }
    const calendars = await listCalendars(conn);
    // Ordena: primário primeiro, depois writable, depois readonly
    calendars.sort((a, b) => {
      if (a.primary !== b.primary) return a.primary ? -1 : 1;
      if (a.writable !== b.writable) return a.writable ? -1 : 1;
      return a.summary.localeCompare(b.summary);
    });
    return { calendars };
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

    // 4. Verificar scope coverage (usa lista canônica de REQUIRED_SCOPES).
    const scopeWarnings = REQUIRED_SCOPES.filter((s) => !conn.scopes.includes(s));

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

  // Debug: inspeciona meetings + holds + simulated_meetings de um lead.
  // Owner-only — pra dirimir bugs sem precisar de acesso direto ao DB.
  app.get('/admin/agents/:agent/projects/:slug/debug/lead', async (req, reply) => {
    const params = ProjectSlugParams.parse(req.params);
    const query = z.object({
      channel: z.string().default('whatsapp'),
      identifier: z.string().min(1),
    }).parse(req.query);
    const project = await getProjectBySlug(params.agent, params.slug);
    if (!project) return reply.code(404).send({ error: 'project not found' });

    const { pool } = await import('../db.js');

    const meetings = await pool.query(
      `SELECT id, status, slot_iso, slot_human, lead_email, lead_name, company,
              google_event_id, google_meet_link, cancelled_by, created_at, updated_at
         FROM meetings
        WHERE project_id = $1 AND channel = $2 AND identifier = $3
        ORDER BY created_at DESC LIMIT 10`,
      [project.id, query.channel, query.identifier]
    );
    const holds = await pool.query(
      `SELECT id, slot_iso, status, google_event_id, expires_at, created_at
         FROM slot_holds
        WHERE project_id = $1 AND channel = $2 AND identifier = $3
        ORDER BY slot_iso ASC LIMIT 30`,
      [project.id, query.channel, query.identifier]
    );
    const simulated = await pool.query(
      `SELECT id, status, slot_iso, slot_human, lead_email, company, created_at
         FROM simulated_meetings
        WHERE agent = $1 AND channel = $2 AND identifier = $3
        ORDER BY created_at DESC LIMIT 5`,
      [params.agent, query.channel, query.identifier]
    );
    return {
      project_id: project.id,
      meetings: meetings.rows,
      holds: holds.rows,
      simulated_meetings: simulated.rows,
    };
  });
}
