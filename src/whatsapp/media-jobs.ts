/**
 * src/whatsapp/media-jobs.ts
 *
 * Fila de download da mídia do WhatsApp (tabela whatsapp_media_jobs, mig 067).
 * Molde de transcription_jobs (db.ts), com `pool` injetado. A política de retry
 * mora em media-policy.ts; aqui só os UPDATEs.
 */
import type { Pool } from 'pg';
import type { MediaRetryPlan } from './media-policy.js';

export type WhatsappMediaJob = {
  id: number;
  message_id: number;
  whatsapp_number_id: number;
  workspace_id: string | null;
  instance: string;
  evolution_event_id: string;
  kind: string;
  raw_envelope: unknown;
  status: string;
  attempts: number;
  created_at: Date;
};

type Q = Pick<Pool, 'query'>;

const COLS = `id, message_id, whatsapp_number_id, workspace_id, instance, evolution_event_id, kind, raw_envelope, status, attempts, created_at`;
// RETURNING num UPDATE ... FROM due precisa qualificar: `id` é ambíguo com a CTE.
const COLS_T = COLS.split(', ').map((c) => `j.${c}`).join(', ');

/** Idempotente por (número, evento): reentrega do webhook não duplica o job. */
export async function insertWhatsappMediaJob(pool: Q, a: {
  message_id: number;
  whatsapp_number_id: number;
  workspace_id: string | null;
  instance: string;
  evolution_event_id: string;
  kind: string;
  raw_envelope: unknown;
}): Promise<{ id: number | null }> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO whatsapp_media_jobs
       (message_id, whatsapp_number_id, workspace_id, instance, evolution_event_id, kind, raw_envelope)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (whatsapp_number_id, evolution_event_id) DO NOTHING
     RETURNING id`,
    [a.message_id, a.whatsapp_number_id, a.workspace_id, a.instance, a.evolution_event_id, a.kind, JSON.stringify(a.raw_envelope)],
  );
  return { id: rows[0]?.id ?? null };
}

/**
 * Claim com lease implícito: soma a tentativa e empurra scheduled_at 5 min à
 * frente. Um processo que morre no meio devolve o job à fila sozinho.
 */
export async function claimDueWhatsappMediaJobs(pool: Q, batchSize: number): Promise<WhatsappMediaJob[]> {
  const { rows } = await pool.query<WhatsappMediaJob>(
    `WITH due AS (
       SELECT id FROM whatsapp_media_jobs
        WHERE status = 'pending' AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE whatsapp_media_jobs j
        SET attempts = j.attempts + 1, scheduled_at = NOW() + INTERVAL '5 minutes', updated_at = NOW()
       FROM due WHERE j.id = due.id
      RETURNING ${COLS_T}`,
    [batchSize],
  );
  return rows;
}

/** Devolve jobs claimados que o disjuntor impediu de processar, sem cobrar a tentativa. */
export async function releaseWhatsappMediaClaims(pool: Q, jobIds: number[], delaySec: number): Promise<void> {
  if (jobIds.length === 0) return;
  await pool.query(
    `UPDATE whatsapp_media_jobs
        SET attempts = GREATEST(attempts - 1, 0),
            scheduled_at = NOW() + ($2 || ' seconds')::INTERVAL,
            updated_at = NOW()
      WHERE id = ANY($1::bigint[]) AND status = 'pending'`,
    [jobIds, String(delaySec)],
  );
}

export async function markWhatsappMediaJobDone(pool: Q, jobId: number): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_media_jobs
        SET status = 'done', raw_envelope = '{}'::jsonb, last_error = NULL, updated_at = NOW()
      WHERE id = $1`,
    [jobId],
  );
}

export async function applyWhatsappMediaRetry(pool: Q, jobId: number, plan: MediaRetryPlan, error: string): Promise<void> {
  if (plan.action === 'fail') {
    await pool.query(
      `UPDATE whatsapp_media_jobs SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
      [jobId, error],
    );
    return;
  }
  const attemptsExpr = plan.consumesAttempt ? 'attempts' : 'GREATEST(attempts - 1, 0)';
  await pool.query(
    `UPDATE whatsapp_media_jobs
        SET status = 'pending', attempts = ${attemptsExpr},
            scheduled_at = NOW() + ($2 || ' seconds')::INTERVAL,
            last_error = $3, updated_at = NOW()
      WHERE id = $1`,
    [jobId, String(plan.backoffSec), error],
  );
}
