import type { Pool, PoolClient } from 'pg';

/** Parameters shared by the single and bulk lead-triage update paths. */
export interface LeadUpdateParams {
  numberId: number;
  identifier: string;
  isLead: boolean;
  updatedBy: string;
  source?: string | null;
  sourcePresent?: boolean;
  disqualifyReason?: string | null;
  disqualifyReasonPresent?: boolean;
  notes?: string | null;
  notesPresent?: boolean;
}

/**
 * Apply a lead-triage update within an already-open transaction.
 * Stage, temperature and legacy thread tags are deliberately frozen.
 */
export async function applyLeadUpdate(client: PoolClient, p: LeadUpdateParams): Promise<void> {
  const prev = await client.query<{ is_lead: boolean }>(
    `SELECT is_lead FROM whatsapp_thread_meta WHERE whatsapp_number_id = $1 AND identifier = $2`,
    [p.numberId, p.identifier],
  );
  const prevRow = prev.rows[0];
  const oldIsLead: string | null = prevRow != null ? String(prevRow.is_lead) : null;
  const newIsLead = String(p.isLead);

  await client.query(
    `INSERT INTO whatsapp_thread_meta
       (whatsapp_number_id, identifier, is_lead, lead_source, disqualify_reason, notes, updated_at, updated_by)
     VALUES ($1, $2, $3, $5, $7, $9, NOW(), $10)
     ON CONFLICT (whatsapp_number_id, identifier)
     DO UPDATE SET
       is_lead           = EXCLUDED.is_lead,
       lead_source       = CASE WHEN $4 THEN $5 ELSE whatsapp_thread_meta.lead_source END,
       disqualify_reason = CASE WHEN $6 THEN $7 ELSE whatsapp_thread_meta.disqualify_reason END,
       notes             = CASE WHEN $8 THEN $9 ELSE whatsapp_thread_meta.notes END,
       updated_at        = NOW(),
       updated_by        = EXCLUDED.updated_by`,
    [
      p.numberId,
      p.identifier,
      p.isLead,
      p.sourcePresent === true,
      p.source ?? null,
      p.disqualifyReasonPresent === true,
      p.disqualifyReason ?? null,
      p.notesPresent === true,
      p.notes ?? null,
      p.updatedBy,
    ],
  );

  // Keep the existing is_lead audit log behavior intact.
  await client.query(
    `INSERT INTO whatsapp_thread_meta_log (whatsapp_number_id, identifier, field, old_value, new_value, actor)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [p.numberId, p.identifier, 'is_lead', oldIsLead, newIsLead, p.updatedBy],
  );
}

export async function setLeadStatus(pool: Pool, p: LeadUpdateParams): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyLeadUpdate(client, p);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original transaction error.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function setGroupExposure(pool: Pool, p: { numberId: number; expose: boolean }): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_numbers SET expose_groups_in_mcp = $2, updated_at = NOW() WHERE id = $1`,
    [p.numberId, p.expose],
  );
}

export async function getNumberExposure(pool: Pool, numberId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT expose_groups_in_mcp FROM whatsapp_numbers WHERE id = $1`,
    [numberId],
  );
  return rows[0]?.expose_groups_in_mcp === true;
}

/** Reuse listThreads' group inference: known group JID or a message author. */
export async function isGroupThread(pool: Pool, numberId: number, identifier: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT (EXISTS (SELECT 1 FROM whatsapp_groups WHERE whatsapp_number_id = $1 AND jid = $2)
          OR EXISTS (SELECT 1 FROM messages WHERE whatsapp_number_id = $1 AND identifier = $2 AND author IS NOT NULL)) AS is_group`,
    [numberId, identifier],
  );
  return rows[0]?.is_group === true;
}
