// src/whatsapp/thread-meta.ts
import type { Pool } from 'pg';

export async function setLeadStatus(pool: Pool, p: { numberId: number; identifier: string; isLead: boolean; updatedBy: string }): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead, updated_at, updated_by)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (whatsapp_number_id, identifier)
     DO UPDATE SET is_lead = EXCLUDED.is_lead, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [p.numberId, p.identifier, p.isLead, p.updatedBy]);
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
