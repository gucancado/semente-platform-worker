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
}): Promise<void> {
  await pool.query(
    `INSERT INTO webhook_logs
       (agent, channel, identifier, evolution_event_id, payload_summary, bloquim_task_id, fallback_used)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      args.agent,
      args.channel,
      args.identifier,
      args.evolution_event_id,
      args.payload_summary,
      args.bloquim_task_id,
      args.fallback_used,
    ]
  );
}
