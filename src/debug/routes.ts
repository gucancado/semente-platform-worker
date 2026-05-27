import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAgentToken } from '../auth.js';
import { pool } from '../db.js';

/**
 * Debug logs — agente posta mensagens livres aqui pra owner inspecionar via REST.
 * Armazena em webhook_logs com instance="__debug__" pra não confundir com inbox real.
 */
export async function registerDebugRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAgentToken);

  app.post('/debug', async (req) => {
    const body = z
      .object({
        source: z.string().default('agent'),
        text: z.string().min(1).max(8000),
      })
      .parse(req.body);

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO webhook_logs
         (agent, channel, instance, identifier, message_text, payload_summary, fallback_used)
       VALUES ($1, 'debug', '__debug__', $2, $3, $4, false)
       RETURNING id`,
      [req.agent.name, body.source, body.text, body.text.slice(0, 80)]
    );
    return { ok: true, id: rows[0]!.id };
  });

  app.get('/debug', async (req) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);

    const { rows } = await pool.query(
      `SELECT id, identifier AS source, message_text, created_at
         FROM webhook_logs
        WHERE agent = $1 AND channel = 'debug'
        ORDER BY created_at DESC
        LIMIT $2`,
      [req.agent.name, query.limit]
    );
    return { logs: rows };
  });

  // Inspect inbox real (mensagens recebidas via webhook, channel != debug).
  //
  // `grouped=true` consolida mensagens não-lidas por (channel, identifier) num
  // único item com texto concatenado em ordem cronológica. Evita que o agente
  // responda 1x por mensagem quando o lead manda várias seguidas (burst).
  // Nesse modo, `limit` aplica ao número de GRUPOS, não mensagens.
  app.get('/inbox-debug', async (req) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        unread_only: z.coerce.boolean().default(false),
        grouped: z.coerce.boolean().default(false),
      })
      .parse(req.query);

    const where = query.unread_only
      ? `agent = $1 AND channel != 'debug' AND processed_at IS NULL`
      : `agent = $1 AND channel != 'debug'`;

    if (query.grouped) {
      // Agrega por (channel, identifier). Concat ignora message_text NULL/vazio
      // (áudio, sticker etc) — se TODOS forem null, message_text vira string vazia
      // e o orquestrador cai no curto-circuito "sem texto".
      const { rows } = await pool.query(
        `SELECT
           channel,
           identifier,
           (array_agg(id ORDER BY created_at ASC)) AS ids,
           COUNT(*)::int AS count,
           (array_agg(instance ORDER BY created_at DESC))[1] AS instance,
           (array_agg(push_name ORDER BY created_at DESC)
              FILTER (WHERE push_name IS NOT NULL))[1] AS push_name,
           COALESCE(
             string_agg(
               NULLIF(message_text, ''),
               E'\n\n' ORDER BY created_at ASC
             ),
             ''
           ) AS message_text,
           MIN(created_at) AS first_received_at,
           MAX(created_at) AS last_received_at
         FROM webhook_logs
        WHERE ${where}
        GROUP BY channel, identifier
        ORDER BY MAX(created_at) DESC
        LIMIT $2`,
        [req.agent.name, query.limit]
      );
      return { messages: rows };
    }

    const { rows } = await pool.query(
      `SELECT id, channel, instance, identifier, push_name, message_text,
              workspace_id, evolution_event_id, fallback_used,
              created_at, processed_at, processed_by
         FROM webhook_logs
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $2`,
      [req.agent.name, query.limit]
    );
    return { messages: rows };
  });

  // Marca item(s) da inbox como processado. Aceita { id } OU { ids: [...] }.
  // Retorna `marked` (count) e `ok` (bool legacy = marked > 0) pra compat.
  app.post('/inbox-debug/mark-read', async (req, reply) => {
    const body = z
      .object({
        id: z.number().int().optional(),
        ids: z.array(z.number().int()).min(1).optional(),
        processed_by: z.string().default('tick'),
      })
      .refine((b) => (b.id !== undefined) !== (b.ids !== undefined), {
        message: 'pass exactly one of { id } or { ids }',
      })
      .parse(req.body);

    const ids = body.ids ?? [body.id!];

    const { rowCount } = await pool.query(
      `UPDATE webhook_logs
          SET processed_at = NOW(),
              processed_by = COALESCE(processed_by, $3)
        WHERE id = ANY($2::bigint[]) AND agent = $1 AND processed_at IS NULL`,
      [req.agent.name, ids, body.processed_by]
    );
    const marked = rowCount ?? 0;
    return reply.send({ marked, ok: marked > 0 });
  });
}
