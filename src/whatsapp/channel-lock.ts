import type { Pool } from 'pg';

export async function acquireChannelLock(pool: Pool, p: { numberId: number; identifier: string; agent: string; ttlSeconds: number }): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO channel_locks (whatsapp_number_id, identifier, locked_by, expires_at)
     VALUES ($1,$2,$3, NOW() + ($4 || ' seconds')::interval)
     ON CONFLICT (whatsapp_number_id, identifier) DO UPDATE
       SET locked_by = EXCLUDED.locked_by, acquired_at = NOW(), expires_at = EXCLUDED.expires_at
       WHERE channel_locks.expires_at < NOW()
     RETURNING locked_by`,
    [p.numberId, p.identifier, p.agent, String(p.ttlSeconds)]);
  // 0 linhas (conflito com lock válido) OU locked_by != agente ⇒ não adquiriu.
  return rows.length === 1 && rows[0].locked_by === p.agent;
}

export async function releaseChannelLock(pool: Pool, p: { numberId: number; identifier: string; agent: string }) {
  await pool.query(
    `DELETE FROM channel_locks WHERE whatsapp_number_id = $1 AND identifier = $2 AND locked_by = $3`,
    [p.numberId, p.identifier, p.agent]);
}
