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
