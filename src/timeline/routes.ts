import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAgentToken } from '../auth.js';
import { insertLlmMetric, insertMessage, pool } from '../db.js';

/**
 * Fase 1 do plano de ação: endpoints REST pro tick.sh registrar mensagens
 * outbound (replies da Mel) e métricas de chamadas LLM (classifier +
 * responder).
 *
 * Inbound é inserido direto pelo /webhook handler — não passa por aqui.
 */
export async function registerTimelineRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAgentToken);

  // ── messages — outbound write + queries ────────────────────────────────

  app.post('/messages', async (req, reply) => {
    const body = z
      .object({
        project: z.string().min(1).optional(),
        channel: z.string().min(1),
        identifier: z.string().min(1),
        direction: z.enum(['inbound', 'outbound']),
        text: z.string().min(1),
        evolution_event_id: z.string().optional(),
        evolution_send_id: z.string().optional(),
        tier: z.string().optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        classifier_intent: z.string().optional(),
        cost_usd: z.number().nonnegative().optional(),
        latency_ms: z.number().int().nonnegative().optional(),
      })
      .parse(req.body);

    const result = await insertMessage({
      agent: req.agent.name,
      project: body.project ?? null,
      channel: body.channel,
      identifier: body.identifier,
      direction: body.direction,
      text: body.text,
      evolution_event_id: body.evolution_event_id ?? null,
      evolution_send_id: body.evolution_send_id ?? null,
      tier: body.tier ?? null,
      model: body.model ?? null,
      provider: body.provider ?? null,
      classifier_intent: body.classifier_intent ?? null,
      cost_usd: body.cost_usd ?? null,
      latency_ms: body.latency_ms ?? null,
    });

    return reply.code(result.duplicate ? 200 : 201).send({
      id: result.id,
      duplicate: result.duplicate,
    });
  });

  app.get('/messages', async (req) => {
    const query = z
      .object({
        channel: z.string().optional(),
        identifier: z.string().optional(),
        direction: z.enum(['inbound', 'outbound']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(50),
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
    if (query.direction) {
      args.push(query.direction);
      conds.push(`direction = $${args.length}`);
    }

    const { rows } = await pool.query(
      `SELECT id, channel, identifier, direction, text,
              evolution_event_id, evolution_send_id,
              tier, model, provider, classifier_intent, cost_usd, latency_ms,
              created_at
         FROM messages
        WHERE ${conds.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT $2`,
      args
    );
    return { messages: rows };
  });

  // ── llm_metrics — write + summary ──────────────────────────────────────

  app.post('/llm-metrics', async (req, reply) => {
    const body = z
      .object({
        message_id: z.number().int().optional(),
        task: z.string().min(1),
        provider: z.string().min(1),
        model: z.string().min(1),
        tier: z.string().optional(),
        tokens_in: z.number().int().nonnegative().optional(),
        tokens_out: z.number().int().nonnegative().optional(),
        cache_read_tokens: z.number().int().nonnegative().optional(),
        cache_write_tokens: z.number().int().nonnegative().optional(),
        cost_usd: z.number().nonnegative().optional(),
        latency_ms: z.number().int().nonnegative().optional(),
        cache_hit: z.boolean().optional(),
        fallback_used: z.boolean().optional(),
        error: z.string().optional(),
      })
      .parse(req.body);

    const result = await insertLlmMetric({
      agent: req.agent.name,
      message_id: body.message_id ?? null,
      task: body.task,
      provider: body.provider,
      model: body.model,
      tier: body.tier ?? null,
      tokens_in: body.tokens_in ?? null,
      tokens_out: body.tokens_out ?? null,
      cache_read_tokens: body.cache_read_tokens ?? null,
      cache_write_tokens: body.cache_write_tokens ?? null,
      cost_usd: body.cost_usd ?? null,
      latency_ms: body.latency_ms ?? null,
      cache_hit: body.cache_hit,
      fallback_used: body.fallback_used,
      error: body.error ?? null,
    });

    return reply.code(201).send({ id: result.id });
  });

  // Agregação simples por dia × task × modelo. Usado pelo painel manual.
  app.get('/metrics/summary', async (req) => {
    const query = z
      .object({
        since: z.string().default('1d'), // 1d|7d|30d
      })
      .parse(req.query);

    const interval =
      query.since === '7d' ? '7 days' :
      query.since === '30d' ? '30 days' :
      '1 day';

    const { rows } = await pool.query(
      `SELECT
         DATE_TRUNC('hour', created_at) AS hour,
         task,
         provider,
         model,
         tier,
         COUNT(*) AS calls,
         SUM(cost_usd)::numeric(10,4) AS cost_total,
         AVG(latency_ms)::int AS latency_avg,
         AVG(cache_read_tokens)::int AS cache_read_avg,
         SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END) AS cache_hits,
         SUM(CASE WHEN fallback_used THEN 1 ELSE 0 END) AS fallbacks,
         SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
       FROM llm_metrics
       WHERE agent = $1
         AND created_at > NOW() - $2::interval
       GROUP BY hour, task, provider, model, tier
       ORDER BY hour DESC, task`,
      [req.agent.name, interval]
    );
    return { since: query.since, rows };
  });
}
