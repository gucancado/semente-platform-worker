import { pool } from '../db.js';

export type WebhookReceipt = {
  id: number; provider: string; external_event_id: string; payload: unknown;
  status: 'received' | 'processed' | 'failed' | 'dead'; attempt_count: number;
  next_attempt_at: Date; claimed_at: Date | null; claimed_by: string | null;
  last_error: string | null; processed_at: Date | null; created_at: Date;
};

/** Idempotente: duplicata retorna { duplicate: true } e o handler responde 200 (spec §5). */
export async function insertReceipt(args: { provider: string; external_event_id: string; payload: unknown }):
  Promise<{ id: number; duplicate: boolean }> {
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO webhook_receipts (provider, external_event_id, payload) VALUES ($1,$2,$3)
     ON CONFLICT (provider, external_event_id) DO NOTHING RETURNING id`,
    [args.provider, args.external_event_id, JSON.stringify(args.payload)]
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, duplicate: false };
  const ex = await pool.query<{ id: number }>(
    `SELECT id FROM webhook_receipts WHERE provider=$1 AND external_event_id=$2`,
    [args.provider, args.external_event_id]
  );
  return { id: ex.rows[0]!.id, duplicate: true };
}

/** Claim com lease: SKIP LOCKED + claimed_at; lease vencido (>10min) é retomável (spec §5, achado #8). */
export async function claimDueReceipts(workerId: string, batchSize = 10): Promise<WebhookReceipt[]> {
  const { rows } = await pool.query<WebhookReceipt>(
    `WITH due AS (
       SELECT id FROM webhook_receipts
        WHERE status IN ('received','failed') AND next_attempt_at <= NOW()
          AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '10 minutes')
        ORDER BY next_attempt_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED
     )
     UPDATE webhook_receipts r SET claimed_at=NOW(), claimed_by=$1, attempt_count=r.attempt_count+1
       FROM due WHERE r.id = due.id RETURNING r.*`,
    [workerId, batchSize]
  );
  return rows;
}

export async function markReceiptProcessed(id: number, claimedBy: string, attemptCount: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE webhook_receipts SET status='processed', processed_at=NOW(), claimed_at=NULL, last_error=NULL
     WHERE id=$1 AND claimed_by=$2 AND attempt_count=$3`,
    [id, claimedBy, attemptCount]
  );
  return (rowCount ?? 0) > 0;
}

export async function markReceiptRetryOrDead(id: number, currentAttempt: number, maxAttempts: number, error: string, claimedBy: string, attemptCount: number): Promise<{ dead: boolean; stale?: boolean }> {
  if (currentAttempt >= maxAttempts) {
    const { rowCount } = await pool.query(
      `UPDATE webhook_receipts SET status='dead', claimed_at=NULL, last_error=$2
       WHERE id=$1 AND claimed_by=$3 AND attempt_count=$4`,
      [id, error, claimedBy, attemptCount]
    );
    if ((rowCount ?? 0) === 0) return { dead: false, stale: true };
    return { dead: true };
  }
  const backoffSec = Math.min(currentAttempt * 30, 300);
  const { rowCount } = await pool.query(
    `UPDATE webhook_receipts SET status='failed', claimed_at=NULL, last_error=$3,
        next_attempt_at = NOW() + ($2 || ' seconds')::INTERVAL
     WHERE id=$1 AND claimed_by=$4 AND attempt_count=$5`,
    [id, String(backoffSec), error, claimedBy, attemptCount]
  );
  if ((rowCount ?? 0) === 0) return { dead: false, stale: true };
  return { dead: false };
}
