import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAgentToken } from '../auth.js';
import { pool } from '../db.js';
import { generateLegacyMockSlots, type DayFilter, type PeriodFilter } from '../goals/scheduling/legacy-mock-slots.js';
import { getProjectBySlug } from '../admin/db.js';
import { suggestSlots } from '../goals/scheduling/service.js';

const LeadKey = z.object({
  channel: z.string().min(1),
  identifier: z.string().min(1),
});

export async function registerSdrRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAgentToken);

  // ── Lead state ────────────────────────────────────────────────────────

  app.get('/lead-state', async (req) => {
    const query = LeadKey.parse(req.query);
    const { rows } = await pool.query<{ state: Record<string, unknown>; updated_at: Date; created_at: Date }>(
      `SELECT state, updated_at, created_at
         FROM lead_states
        WHERE agent = $1 AND channel = $2 AND identifier = $3`,
      [req.agent.name, query.channel, query.identifier]
    );
    if (!rows[0]) return { state: null, exists: false };
    return { state: rows[0].state, exists: true, updated_at: rows[0].updated_at, created_at: rows[0].created_at };
  });

  // Patch (merge JSONB no estado salvo). Body: { channel, identifier, patch }.
  app.post('/lead-state', async (req) => {
    const body = z
      .object({
        channel: z.string().min(1),
        identifier: z.string().min(1),
        patch: z.record(z.string(), z.unknown()),
      })
      .parse(req.body);

    // Postgres jsonb concatenation `||` faz shallow merge top-level.
    // Pra campos aninhados (qualificacao, fatos_coletados), o caller envia o objeto inteiro.
    const { rows } = await pool.query<{ state: Record<string, unknown> }>(
      `INSERT INTO lead_states (agent, channel, identifier, state, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())
       ON CONFLICT (agent, channel, identifier)
       DO UPDATE SET state = lead_states.state || EXCLUDED.state, updated_at = NOW()
       RETURNING state`,
      [req.agent.name, body.channel, body.identifier, JSON.stringify(body.patch)]
    );
    return { state: rows[0]!.state };
  });

  // ── Handoff ───────────────────────────────────────────────────────────

  app.post('/handoff', async (req) => {
    const body = z
      .object({
        channel: z.string().min(1),
        identifier: z.string().min(1),
        motivo: z.string().min(1),
        urgencia: z.enum(['alta', 'media', 'baixa']).default('media'),
        contexto_resumido: z.string().max(2000).optional(),
      })
      .parse(req.body);

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO handoffs (agent, channel, identifier, motivo, urgencia, contexto_resumido)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [req.agent.name, body.channel, body.identifier, body.motivo, body.urgencia, body.contexto_resumido ?? null]
    );
    return { id: rows[0]!.id, ok: true };
  });

  app.get('/handoffs', async (req) => {
    const query = z
      .object({
        status: z.enum(['open', 'claimed', 'resolved', 'dismissed', 'all']).default('open'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);

    const where = query.status === 'all' ? 'agent = $1' : 'agent = $1 AND status = $3';
    const args: unknown[] = [req.agent.name, query.limit];
    if (query.status !== 'all') args.push(query.status);

    const { rows } = await pool.query(
      `SELECT id, channel, identifier, motivo, urgencia, contexto_resumido, status, created_at, resolved_at, resolved_by
         FROM handoffs
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $2`,
      args
    );
    return { handoffs: rows };
  });

  app.post('/handoffs/:id/resolve', async (req) => {
    const params = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z
      .object({
        resolved_by: z.string().default('owner'),
        status: z.enum(['resolved', 'dismissed']).default('resolved'),
      })
      .parse(req.body);

    const { rowCount } = await pool.query(
      `UPDATE handoffs
          SET status = $3, resolved_at = NOW(), resolved_by = $4
        WHERE id = $2 AND agent = $1 AND status = 'open'`,
      [req.agent.name, params.id, body.status, body.resolved_by]
    );
    return { resolved: (rowCount ?? 0) > 0 };
  });

  // ── Reset de lead (testes) ────────────────────────────────────────────

  /**
   * Wipe completo de um lead. Útil pra reiniciar conversa em testes.
   * Apaga lead_state, cancela meetings em aberto, fecha handoffs em aberto,
   * marca todas as mensagens não-lidas em webhook_logs como processadas
   * (pra não voltar na inbox).
   */
  app.post('/sdr/reset', async (req) => {
    const body = z
      .object({
        channel: z.string().min(1),
        identifier: z.string().min(1),
      })
      .parse(req.body);

    const { rowCount: stateDel } = await pool.query(
      `DELETE FROM lead_states WHERE agent = $1 AND channel = $2 AND identifier = $3`,
      [req.agent.name, body.channel, body.identifier]
    );

    const { rowCount: meetingsCancelled } = await pool.query(
      `UPDATE simulated_meetings
          SET status = 'cancelled', updated_at = NOW()
        WHERE agent = $1 AND channel = $2 AND identifier = $3 AND status = 'scheduled'`,
      [req.agent.name, body.channel, body.identifier]
    );

    const { rowCount: handoffsClosed } = await pool.query(
      `UPDATE handoffs
          SET status = 'dismissed', resolved_at = NOW(), resolved_by = 'reset'
        WHERE agent = $1 AND channel = $2 AND identifier = $3 AND status = 'open'`,
      [req.agent.name, body.channel, body.identifier]
    );

    const { rowCount: inboxMarked } = await pool.query(
      `UPDATE webhook_logs
          SET processed_at = NOW(), processed_by = 'reset'
        WHERE agent = $1 AND channel = $2 AND identifier = $3 AND processed_at IS NULL`,
      [req.agent.name, body.channel, body.identifier]
    );

    return {
      ok: true,
      cleared: {
        state: (stateDel ?? 0) > 0,
        meetings_cancelled: meetingsCancelled ?? 0,
        handoffs_closed: handoffsClosed ?? 0,
        inbox_marked_read: inboxMarked ?? 0,
      },
    };
  });

  // ── Meetings (simulado por enquanto) ──────────────────────────────────

  /**
   * Sugere 3 slots respeitando regras (seg-sex, 9-12 e 14-18, antecedência 4h,
   * pula feriado, etc.). Por enquanto, gerador determinístico simples — sem
   * integração com Google Calendar. Aceita filtro opcional.
   */
  app.get('/meetings/suggest-slots', async (req) => {
    const query = z
      .object({
        day: z.enum(['qualquer', 'seg', 'ter', 'qua', 'qui', 'sex']).default('qualquer'),
        period: z.enum(['qualquer', 'manha', 'tarde']).default('qualquer'),
        project: z.string().min(1).optional(),
        channel: z.string().min(1).optional(),
        identifier: z.string().min(1).optional(),
      })
      .parse(req.query);

    // Caminho legado: sem project/channel/identifier → continua gerador determinístico.
    if (!query.project || !query.channel || !query.identifier) {
      return {
        slots: generateLegacyMockSlots(query.day as DayFilter, query.period as PeriodFilter),
        source: 'mock' as const,
        fallback_reason: 'missing_params',
      };
    }

    const project = await getProjectBySlug(req.agent.name, query.project);
    if (!project) {
      return {
        slots: generateLegacyMockSlots(query.day as DayFilter, query.period as PeriodFilter),
        source: 'mock' as const,
        fallback_reason: 'project_not_found',
      };
    }

    const result = await suggestSlots({
      project_id: project.id,
      channel: query.channel,
      identifier: query.identifier,
      dayFilter: query.day as DayFilter,
      periodFilter: query.period as PeriodFilter,
    });

    req.log.info({
      op: 'sdr.suggest_slots',
      agent: req.agent.name,
      project: query.project,
      channel: query.channel,
      identifier: query.identifier,
      source: result.source,
      fallback_reason: result.fallback_reason,
      slot_count: result.slots.length,
    }, 'sdr suggest-slots');

    return {
      slots: result.slots,
      source: result.source,
      fallback_reason: result.fallback_reason,
      agenda: result.agenda,
    };
  });

  app.post('/meetings/schedule', async (req) => {
    const body = z
      .object({
        channel: z.string().min(1),
        identifier: z.string().min(1),
        slot_iso: z.string().datetime({ offset: true }),
        slot_human: z.string().min(1),
        lead_email: z.string().email().optional(),
        lead_name: z.string().optional(),
        company: z.string().optional(),
        contexto: z.string().max(2000).optional(),
      })
      .parse(req.body);

    // Dedup: se já há meeting "scheduled" pro lead, devolve a existente em vez
    // de criar duplicada. Defesa em profundidade pra erro de re-emissão.
    const existing = await pool.query<{ id: number; slot_human: string }>(
      `SELECT id, slot_human FROM simulated_meetings
        WHERE agent = $1 AND channel = $2 AND identifier = $3 AND status = 'scheduled'
        ORDER BY created_at DESC
        LIMIT 1`,
      [req.agent.name, body.channel, body.identifier]
    );
    if (existing.rows[0]) {
      return {
        id: existing.rows[0].id,
        ok: true,
        simulated: true,
        already_scheduled: true,
        existing_slot_human: existing.rows[0].slot_human,
      };
    }

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO simulated_meetings (agent, channel, identifier, slot_iso, slot_human, lead_email, lead_name, company, contexto)
       VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        req.agent.name,
        body.channel,
        body.identifier,
        body.slot_iso,
        body.slot_human,
        body.lead_email ?? null,
        body.lead_name ?? null,
        body.company ?? null,
        body.contexto ?? null,
      ]
    );
    return { id: rows[0]!.id, ok: true, simulated: true };
  });

  app.post('/meetings/:id/cancel', async (req) => {
    const params = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { rowCount } = await pool.query(
      `UPDATE simulated_meetings
          SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND agent = $2 AND status = 'scheduled'`,
      [params.id, req.agent.name]
    );
    return { cancelled: (rowCount ?? 0) > 0 };
  });

  app.post('/meetings/:id/reschedule', async (req) => {
    const params = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z
      .object({
        slot_iso: z.string().datetime({ offset: true }),
        slot_human: z.string().min(1),
      })
      .parse(req.body);

    const orig = await pool.query<{ channel: string; identifier: string; lead_email: string | null; lead_name: string | null; company: string | null; contexto: string | null }>(
      `SELECT channel, identifier, lead_email, lead_name, company, contexto
         FROM simulated_meetings WHERE id = $1 AND agent = $2`,
      [params.id, req.agent.name]
    );
    if (!orig.rows[0]) return { error: 'meeting not found' };

    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO simulated_meetings (agent, channel, identifier, slot_iso, slot_human, lead_email, lead_name, company, contexto)
       VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        req.agent.name,
        orig.rows[0].channel,
        orig.rows[0].identifier,
        body.slot_iso,
        body.slot_human,
        orig.rows[0].lead_email,
        orig.rows[0].lead_name,
        orig.rows[0].company,
        orig.rows[0].contexto,
      ]
    );

    await pool.query(
      `UPDATE simulated_meetings
          SET status = 'rescheduled', rescheduled_to = $2, updated_at = NOW()
        WHERE id = $1`,
      [params.id, inserted.rows[0]!.id]
    );

    return { new_id: inserted.rows[0]!.id, ok: true };
  });

  app.get('/meetings', async (req) => {
    const query = z
      .object({
        channel: z.string().optional(),
        identifier: z.string().optional(),
        status: z.enum(['scheduled', 'rescheduled', 'cancelled', 'completed', 'no_show', 'all']).default('all'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);

    const conds: string[] = ['agent = $1'];
    const args: unknown[] = [req.agent.name, query.limit];
    if (query.channel) {
      args.push(query.channel);
      conds.push(`channel = $${args.length}`);
    }
    if (query.identifier) {
      args.push(query.identifier);
      conds.push(`identifier = $${args.length}`);
    }
    if (query.status !== 'all') {
      args.push(query.status);
      conds.push(`status = $${args.length}`);
    }

    const { rows } = await pool.query(
      `SELECT id, channel, identifier, slot_iso, slot_human, lead_email, lead_name, company, contexto,
              status, rescheduled_to, created_at
         FROM simulated_meetings
        WHERE ${conds.join(' AND ')}
        ORDER BY slot_iso DESC
        LIMIT $2`,
      args
    );
    return { meetings: rows };
  });
}
