import type { Pool } from 'pg';
import type { QueuedNotice } from './digest.js';

/**
 * Fila `ops_notify_queue` (mig 070). Todo aviso ao operador entra aqui; quem
 * envia é o `flusher.ts`, em lote.
 */

export type Urgency = 'urgent' | 'digest';

export async function enqueueOps(
  pool: Pool,
  n: { titulo: string; detalhe?: string | null; urgency: Urgency; source: string },
): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO ops_notify_queue (titulo, detalhe, urgency, source)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [n.titulo, n.detalhe ?? null, n.urgency, n.source],
  );
  const row = r.rows[0];
  if (!row) throw new Error('ops_notify_queue: INSERT sem RETURNING');
  return Number(row.id);
}

/** Pendentes = não enviados e fora de lease (lease vivo = lote em envio ou em backoff). */
const PENDING = `sent_at IS NULL AND (claimed_at IS NULL OR claimed_at < NOW() - ($1 || ' minutes')::interval)`;

export async function pendingSummary(
  pool: Pool,
  leaseMin: number,
): Promise<{ oldestUrgentAt: Date | null; oldestPendingAt: Date | null }> {
  const r = await pool.query<{ oldest_urgent: Date | null; oldest_any: Date | null }>(
    `SELECT MIN(created_at) FILTER (WHERE urgency = 'urgent') AS oldest_urgent,
            MIN(created_at) AS oldest_any
       FROM ops_notify_queue
      WHERE ${PENDING}`,
    [String(leaseMin)],
  );
  return { oldestUrgentAt: r.rows[0]?.oldest_urgent ?? null, oldestPendingAt: r.rows[0]?.oldest_any ?? null };
}

/**
 * Reivindica o lote num UPDATE só (SELECT … FOR UPDATE SKIP LOCKED): dois
 * containers no rolling deploy não mandam o mesmo resumo duas vezes.
 */
export async function claimBatch(
  pool: Pool,
  leaseMin: number,
  limit: number,
): Promise<Array<QueuedNotice & { id: number }>> {
  const r = await pool.query<{ id: string; titulo: string; detalhe: string | null; urgency: Urgency; created_at: Date }>(
    `UPDATE ops_notify_queue q
        SET claimed_at = NOW(), attempts = q.attempts + 1
       FROM (SELECT id FROM ops_notify_queue
              WHERE ${PENDING}
              ORDER BY created_at ASC
              LIMIT $2
              FOR UPDATE SKIP LOCKED) c
      WHERE q.id = c.id
      RETURNING q.id, q.titulo, q.detalhe, q.urgency, q.created_at`,
    [String(leaseMin), limit],
  );
  return r.rows
    .map((x) => ({ id: Number(x.id), titulo: x.titulo, detalhe: x.detalhe, urgency: x.urgency, createdAt: x.created_at }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export async function markSent(pool: Pool, ids: number[], sendId: string | null): Promise<void> {
  await pool.query(`UPDATE ops_notify_queue SET sent_at = NOW(), send_id = $2, last_error = NULL WHERE id = ANY($1::bigint[])`, [
    ids,
    sendId,
  ]);
}

/**
 * Falha mantém o `claimed_at`: o lote volta quando o lease expira. Zerar faria a
 * mesma recusa repetir a cada tick do flusher.
 */
export async function markFailed(pool: Pool, ids: number[], error: unknown): Promise<void> {
  await pool.query(`UPDATE ops_notify_queue SET last_error = $2::jsonb WHERE id = ANY($1::bigint[])`, [
    ids,
    JSON.stringify(error ?? null),
  ]);
}
