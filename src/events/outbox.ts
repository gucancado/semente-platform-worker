import type { PoolClient } from 'pg';
import { pool } from '../db.js';

export type SubscribersConfig = Record<string, Record<string, { url: string; secrets: string[] }>>;

export type OutboxEvent = {
  id: number; event_type: string; aggregate_type: string; aggregate_id: string;
  payload: unknown; dispatched_at: Date | null; created_at: Date;
};

export type ClaimedDelivery = {
  id: number; event_id: number; subscriber_key: string; attempt_count: number;
  event_type: string; payload: unknown; event_created_at: Date;
};

/** Grava o evento DENTRO da transação do caller (padrão outbox — spec §4.1). */
export async function insertEventTx(client: PoolClient, args: {
  event_type: string; aggregate_type: string; aggregate_id: string; payload: unknown;
}): Promise<{ id: number }> {
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO event_outbox (event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [args.event_type, args.aggregate_type, args.aggregate_id, JSON.stringify(args.payload)]
  );
  return rows[0]!;
}

/**
 * Etapa (a) do dispatcher: expande eventos não-despachados em delivery rows.
 * UMA transação por batch: claim FOR UPDATE SKIP LOCKED → INSERT deliveries
 * (ON CONFLICT DO NOTHING) → dispatched_at, tudo junto — crash nunca deixa
 * evento despachado sem entregas (spec §4.2 / achado Codex #1).
 * Config lida dentro da TX = snapshot do evento.
 */
export async function expandPendingEvents(subscribers: SubscribersConfig, batchSize = 50): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: events } = await client.query<OutboxEvent>(
      `SELECT * FROM event_outbox WHERE dispatched_at IS NULL
        ORDER BY id ASC LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batchSize]
    );
    for (const ev of events) {
      const subs = subscribers[ev.event_type] ?? {};
      for (const key of Object.keys(subs)) {
        await client.query(
          `INSERT INTO event_outbox_deliveries (event_id, subscriber_key)
           VALUES ($1, $2) ON CONFLICT (event_id, subscriber_key) DO NOTHING`,
          [ev.id, key]
        );
      }
      await client.query(`UPDATE event_outbox SET dispatched_at = NOW() WHERE id = $1`, [ev.id]);
    }
    await client.query('COMMIT');
    return events.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Etapa (b): claim de entregas devidas (padrão claimDuePendingTriggers de src/db.ts). */
export async function claimDueDeliveries(batchSize = 50): Promise<ClaimedDelivery[]> {
  const { rows } = await pool.query<ClaimedDelivery>(
    `WITH due AS (
       SELECT d.id FROM event_outbox_deliveries d
        WHERE d.status = 'pending' AND d.next_attempt_at <= NOW()
        ORDER BY d.next_attempt_at ASC LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE event_outbox_deliveries d
        SET attempt_count = d.attempt_count + 1,
            next_attempt_at = NOW() + INTERVAL '60 seconds'
       FROM due, event_outbox e
      WHERE d.id = due.id AND e.id = d.event_id
      RETURNING d.id, d.event_id, d.subscriber_key, d.attempt_count,
                e.event_type, e.payload, e.created_at AS event_created_at`,
    [batchSize]
  );
  return rows;
}

export async function markDeliveryDelivered(id: number): Promise<void> {
  await pool.query(
    `UPDATE event_outbox_deliveries SET status='delivered', delivered_at=NOW(), last_error=NULL WHERE id=$1`,
    [id]
  );
}

/** Backoff 30s×attempt (cap 5min); esgotou → dead (dead-letter consultável). */
export async function markDeliveryRetryOrDead(
  id: number, currentAttempt: number, maxAttempts: number, error: string
): Promise<{ dead: boolean }> {
  if (currentAttempt >= maxAttempts) {
    await pool.query(`UPDATE event_outbox_deliveries SET status='dead', last_error=$2 WHERE id=$1`, [id, error]);
    return { dead: true };
  }
  const backoffSec = Math.min(currentAttempt * 30, 300);
  await pool.query(
    `UPDATE event_outbox_deliveries
        SET status='pending', next_attempt_at = NOW() + ($2 || ' seconds')::INTERVAL, last_error=$3
      WHERE id=$1`,
    [id, String(backoffSec), error]
  );
  return { dead: false };
}

export async function listDeadDeliveries(limit = 100): Promise<Array<ClaimedDelivery & { last_error: string | null }>> {
  const { rows } = await pool.query(
    `SELECT d.id, d.event_id, d.subscriber_key, d.attempt_count, d.last_error,
            e.event_type, e.payload, e.created_at AS event_created_at
       FROM event_outbox_deliveries d JOIN event_outbox e ON e.id = d.event_id
      WHERE d.status = 'dead' ORDER BY d.created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Replay admin: volta pra pending, zera tentativas, preserva last_error (spec §4.2). */
export async function requeueDelivery(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE event_outbox_deliveries
        SET status='pending', attempt_count=0, next_attempt_at=NOW(), delivered_at=NULL
      WHERE id=$1 AND status='dead'`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}
