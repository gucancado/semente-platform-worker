import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export type ContactRoute = {
  id: number;
  agent: string;
  channel: 'whatsapp' | 'email';
  identifier: string;
  workspace_id: string;
  display_name: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function lookupContact(
  agent: string,
  channel: string,
  identifier: string
): Promise<ContactRoute | null> {
  const { rows } = await pool.query<ContactRoute>(
    `SELECT * FROM contact_routes WHERE agent = $1 AND channel = $2 AND identifier = $3 LIMIT 1`,
    [agent, channel, identifier]
  );
  return rows[0] ?? null;
}

export async function upsertContact(args: {
  agent: string;
  channel: string;
  identifier: string;
  workspace_id: string;
  display_name?: string | null;
  notes?: string | null;
}): Promise<ContactRoute> {
  const { rows } = await pool.query<ContactRoute>(
    `INSERT INTO contact_routes (agent, channel, identifier, workspace_id, display_name, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (agent, channel, identifier)
     DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id,
       display_name = COALESCE(EXCLUDED.display_name, contact_routes.display_name),
       notes = COALESCE(EXCLUDED.notes, contact_routes.notes),
       updated_at = NOW()
     RETURNING *`,
    [
      args.agent,
      args.channel,
      args.identifier,
      args.workspace_id,
      args.display_name ?? null,
      args.notes ?? null,
    ]
  );
  return rows[0]!;
}

export async function listContactsByWorkspace(
  agent: string,
  workspace_id: string
): Promise<ContactRoute[]> {
  const { rows } = await pool.query<ContactRoute>(
    `SELECT * FROM contact_routes WHERE agent = $1 AND workspace_id = $2 ORDER BY created_at DESC`,
    [agent, workspace_id]
  );
  return rows;
}

export async function deleteContact(agent: string, id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM contact_routes WHERE agent = $1 AND id = $2`,
    [agent, id]
  );
  return (rowCount ?? 0) > 0;
}

export async function logWebhook(args: {
  agent: string;
  channel: string;
  identifier: string | null;
  evolution_event_id: string | null;
  payload_summary: string | null;
  bloquim_task_id: string | null;
  fallback_used: boolean;
  instance?: string | null;
  push_name?: string | null;
  message_text?: string | null;
  workspace_id?: string | null;
}): Promise<{ id: number; duplicate: boolean }> {
  // Dedup: índice único parcial em (agent, evolution_event_id). Se Evolution
  // re-emite o mesmo evento, ON CONFLICT cai no DO NOTHING e a query principal
  // não retorna linha — buscamos o id existente num segundo SELECT.
  const insert = await pool.query<{ id: number }>(
    `INSERT INTO webhook_logs
       (agent, channel, identifier, evolution_event_id, payload_summary, bloquim_task_id, fallback_used,
        instance, push_name, message_text, workspace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (agent, evolution_event_id) WHERE evolution_event_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      args.agent,
      args.channel,
      args.identifier,
      args.evolution_event_id,
      args.payload_summary,
      args.bloquim_task_id,
      args.fallback_used,
      args.instance ?? null,
      args.push_name ?? null,
      args.message_text ?? null,
      args.workspace_id ?? null,
    ]
  );
  if (insert.rows[0]) {
    return { id: insert.rows[0].id, duplicate: false };
  }
  const existing = await pool.query<{ id: number }>(
    `SELECT id FROM webhook_logs WHERE agent = $1 AND evolution_event_id = $2 LIMIT 1`,
    [args.agent, args.evolution_event_id]
  );
  return { id: existing.rows[0]!.id, duplicate: true };
}

export type InboxItem = {
  id: number;
  agent: string;
  channel: string;
  instance: string | null;
  identifier: string | null;
  push_name: string | null;
  message_text: string | null;
  workspace_id: string | null;
  evolution_event_id: string | null;
  created_at: Date;
};

/**
 * Lista mensagens recebidas e ainda não processadas pelo agente.
 * Default: mais antigas primeiro (FIFO) — não perde mensagem em fila longa.
 */
export async function listUnreadInbox(
  agent: string,
  limit = 20,
  instance?: string
): Promise<InboxItem[]> {
  const args: unknown[] = [agent, limit];
  let where = `agent = $1 AND processed_at IS NULL`;
  if (instance) {
    args.push(instance);
    where += ` AND instance = $3`;
  }
  const { rows } = await pool.query<InboxItem>(
    `SELECT id, agent, channel, instance, identifier, push_name, message_text,
            workspace_id, evolution_event_id, created_at
       FROM webhook_logs
      WHERE ${where}
      ORDER BY created_at ASC
      LIMIT $2`,
    args
  );
  return rows;
}

/**
 * Marca uma mensagem como processada. Idempotente — re-marcar não falha
 * mas não altera processed_at original.
 */
export async function markInboxRead(
  agent: string,
  id: number,
  processedBy: string
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE webhook_logs
        SET processed_at = NOW(),
            processed_by = COALESCE(processed_by, $3)
      WHERE id = $2 AND agent = $1 AND processed_at IS NULL`,
    [agent, id, processedBy]
  );
  return (rowCount ?? 0) > 0;
}

// ── Fase 1: messages + llm_metrics ──────────────────────────────────────

export type MessageRow = {
  id: number;
  agent: string;
  channel: string;
  identifier: string;
  direction: 'inbound' | 'outbound';
  text: string;
  evolution_event_id: string | null;
  evolution_send_id: string | null;
  tier: string | null;
  model: string | null;
  provider: string | null;
  classifier_intent: string | null;
  cost_usd: string | null;
  latency_ms: number | null;
  created_at: Date;
};

/**
 * Insere uma mensagem na linha do tempo conversacional.
 * Dedup automático pra inbound via índice único parcial em (agent, evolution_event_id).
 * Retorna { id, duplicate } no padrão de logWebhook — duplicate=true quando o
 * INSERT cai em ON CONFLICT e a row já existia.
 */
export async function insertMessage(args: {
  agent: string;
  project?: string | null;
  channel: string;
  identifier: string;
  direction: 'inbound' | 'outbound';
  text: string;
  evolution_event_id?: string | null;
  evolution_send_id?: string | null;
  tier?: string | null;
  model?: string | null;
  provider?: string | null;
  classifier_intent?: string | null;
  cost_usd?: number | null;
  latency_ms?: number | null;
}): Promise<{ id: number; duplicate: boolean }> {
  // Pra inbound com evolution_event_id, tenta ON CONFLICT (dedup).
  // Pra outbound ou inbound sem event_id, insert direto.
  if (args.direction === 'inbound' && args.evolution_event_id) {
    const insert = await pool.query<{ id: number }>(
      `INSERT INTO messages
         (agent, project, channel, identifier, direction, text, evolution_event_id)
       VALUES ($1, $2, $3, $4, 'inbound', $5, $6)
       ON CONFLICT (agent, evolution_event_id)
         WHERE direction = 'inbound' AND evolution_event_id IS NOT NULL
         DO NOTHING
       RETURNING id`,
      [args.agent, args.project ?? null, args.channel, args.identifier, args.text, args.evolution_event_id]
    );
    if (insert.rows[0]) return { id: insert.rows[0].id, duplicate: false };

    const existing = await pool.query<{ id: number }>(
      `SELECT id FROM messages
        WHERE agent = $1 AND direction = 'inbound' AND evolution_event_id = $2
        LIMIT 1`,
      [args.agent, args.evolution_event_id]
    );
    return { id: existing.rows[0]!.id, duplicate: true };
  }

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO messages
       (agent, project, channel, identifier, direction, text,
        evolution_event_id, evolution_send_id,
        tier, model, provider, classifier_intent, cost_usd, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      args.agent,
      args.project ?? null,
      args.channel,
      args.identifier,
      args.direction,
      args.text,
      args.evolution_event_id ?? null,
      args.evolution_send_id ?? null,
      args.tier ?? null,
      args.model ?? null,
      args.provider ?? null,
      args.classifier_intent ?? null,
      args.cost_usd ?? null,
      args.latency_ms ?? null,
    ]
  );
  return { id: rows[0]!.id, duplicate: false };
}

export async function insertLlmMetric(args: {
  agent: string;
  message_id?: number | null;
  task: string;
  provider: string;
  model: string;
  tier?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  cost_usd?: number | null;
  latency_ms?: number | null;
  cache_hit?: boolean;
  fallback_used?: boolean;
  error?: string | null;
}): Promise<{ id: number }> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO llm_metrics
       (agent, message_id, task, provider, model, tier,
        tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
        cost_usd, latency_ms, cache_hit, fallback_used, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      args.agent,
      args.message_id ?? null,
      args.task,
      args.provider,
      args.model,
      args.tier ?? null,
      args.tokens_in ?? null,
      args.tokens_out ?? null,
      args.cache_read_tokens ?? null,
      args.cache_write_tokens ?? null,
      args.cost_usd ?? null,
      args.latency_ms ?? null,
      args.cache_hit ?? false,
      args.fallback_used ?? false,
      args.error ?? null,
    ]
  );
  return { id: rows[0]!.id };
}
