// src/whatsapp/thread-meta.ts
import type { Pool, PoolClient } from 'pg';

export async function setLeadStatus(
  pool: Pool,
  p: {
    numberId: number;
    identifier: string;
    isLead: boolean;
    updatedBy: string;
    // optional qualification fields (T7)
    stage?: string | null;
    temperature?: string | null;
    source?: string | null;
    disqualifyReason?: string | null;
    tags?: string[] | null;
    notes?: string | null;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Read the PREVIOUS values before the upsert so we can record the transition.
    const prev = await client.query<{ is_lead: boolean; lead_stage: string | null }>(
      `SELECT is_lead, lead_stage FROM whatsapp_thread_meta WHERE whatsapp_number_id = $1 AND identifier = $2`,
      [p.numberId, p.identifier],
    );
    const prevRow = prev.rows[0];
    const oldIsLead: string | null = prevRow != null ? String(prevRow.is_lead) : null;
    const newIsLead = String(p.isLead);
    const oldStage: string | null = prevRow?.lead_stage ?? null;

    // Upsert the lead status + optional qualification fields.
    await client.query(
      `INSERT INTO whatsapp_thread_meta
         (whatsapp_number_id, identifier, is_lead, lead_stage, lead_temperature, lead_source, disqualify_reason, notes, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
       ON CONFLICT (whatsapp_number_id, identifier)
       DO UPDATE SET
         is_lead          = EXCLUDED.is_lead,
         lead_stage       = COALESCE(EXCLUDED.lead_stage, whatsapp_thread_meta.lead_stage),
         lead_temperature = COALESCE(EXCLUDED.lead_temperature, whatsapp_thread_meta.lead_temperature),
         lead_source      = COALESCE(EXCLUDED.lead_source, whatsapp_thread_meta.lead_source),
         disqualify_reason = COALESCE(EXCLUDED.disqualify_reason, whatsapp_thread_meta.disqualify_reason),
         notes            = COALESCE(EXCLUDED.notes, whatsapp_thread_meta.notes),
         updated_at       = NOW(),
         updated_by       = EXCLUDED.updated_by`,
      [
        p.numberId, p.identifier, p.isLead,
        p.stage ?? null, p.temperature ?? null, p.source ?? null,
        p.disqualifyReason ?? null, p.notes ?? null,
        p.updatedBy,
      ],
    );

    // Replace tags when explicitly provided.
    if (p.tags != null) {
      await replaceTags(client, p.numberId, p.identifier, p.tags);
    }

    // Record is_lead transition.
    await client.query(
      `INSERT INTO whatsapp_thread_meta_log (whatsapp_number_id, identifier, field, old_value, new_value, actor)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [p.numberId, p.identifier, 'is_lead', oldIsLead, newIsLead, p.updatedBy],
    );

    // Record lead_stage transition when stage is changing.
    if (p.stage !== undefined && p.stage !== oldStage) {
      await client.query(
        `INSERT INTO whatsapp_thread_meta_log (whatsapp_number_id, identifier, field, old_value, new_value, actor)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [p.numberId, p.identifier, 'lead_stage', oldStage, p.stage ?? null, p.updatedBy],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    // ROLLBACK may itself throw on a dead connection; isolate it so the original
    // error always propagates to the caller instead of a misleading rollback error.
    try { await client.query('ROLLBACK'); } catch { /* ignore rollback failure */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Replace all tags for a thread within an existing transaction. */
async function replaceTags(client: PoolClient, numberId: number, identifier: string, tags: string[]): Promise<void> {
  await client.query(
    `DELETE FROM whatsapp_thread_tags WHERE whatsapp_number_id = $1 AND identifier = $2`,
    [numberId, identifier],
  );
  for (const tag of tags) {
    await client.query(
      `INSERT INTO whatsapp_thread_tags (whatsapp_number_id, identifier, tag) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [numberId, identifier, tag],
    );
  }
}

export async function setGroupExposure(pool: Pool, p: { numberId: number; expose: boolean }): Promise<void> {
  await pool.query(`UPDATE whatsapp_numbers SET expose_groups_in_mcp = $2, updated_at = NOW() WHERE id = $1`, [p.numberId, p.expose]);
}

export async function getNumberExposure(pool: Pool, numberId: number): Promise<boolean> {
  const { rows } = await pool.query(`SELECT expose_groups_in_mcp FROM whatsapp_numbers WHERE id = $1`, [numberId]);
  return rows[0]?.expose_groups_in_mcp === true;
}

/** Reusa a derivação de kind do listThreads: grupo se whatsapp_groups.jid OU author presente. */
export async function isGroupThread(pool: Pool, numberId: number, identifier: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT (EXISTS (SELECT 1 FROM whatsapp_groups WHERE whatsapp_number_id = $1 AND jid = $2)
          OR EXISTS (SELECT 1 FROM messages WHERE whatsapp_number_id = $1 AND identifier = $2 AND author IS NOT NULL)) AS is_group`,
    [numberId, identifier]);
  return rows[0]?.is_group === true;
}
