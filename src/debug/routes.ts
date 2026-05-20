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
}
