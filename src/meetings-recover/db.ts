import type { Pool } from 'pg';
import type { RecoveryReason } from '../meetings-collect/service.js';

export async function enqueueRecovery(pool: Pool, collectedId: string, reason: RecoveryReason): Promise<void> {
  // 'partial' vence 'silent_room' de uma tentativa anterior? Não há esse caso:
  // a mesma coleta termina uma vez só. ON CONFLICT só protege reentrega.
  await pool.query(
    `INSERT INTO meeting_recovery_jobs (collected_meeting_id, reason) VALUES ($1, $2)
     ON CONFLICT (collected_meeting_id) DO NOTHING`,
    [collectedId, reason],
  );
}

export type RecoveryJob = {
  collected_meeting_id: string;
  reason: RecoveryReason;
  attempts: number;
  created_at: Date;
  meet_code: string;
  vexa_meeting_id: number | null;
  workspace_id: string | null;
  title: string | null;
  started_at: Date | null;
  requested_at: Date;
  episode_id: number | null;
};

/** Lease longo: uma reunião de 2h são ~30 pedaços de ~1–2 min cada. */
export const RECOVERY_LEASE_MIN = 180;

/** Reivindica UM job (um por vez: chamadas longas, fila curta). Lease explícito
 *  — mesmo motivo do digest: `scheduled_at` sozinho deixaria uma execução lenta
 *  ser reivindicada de novo no meio. */
export async function claimRecoveryJob(pool: Pool): Promise<RecoveryJob | null> {
  const r = await pool.query<RecoveryJob>(
    `UPDATE meeting_recovery_jobs j
        SET status = 'processing', claimed_at = NOW(), updated_at = NOW()
       FROM (SELECT collected_meeting_id FROM meeting_recovery_jobs
              WHERE (status = 'pending' AND scheduled_at <= NOW())
                 OR (status = 'processing' AND claimed_at < NOW() - ($1 || ' minutes')::interval)
              ORDER BY scheduled_at ASC
              LIMIT 1
              FOR UPDATE SKIP LOCKED) c,
            collected_meetings cm
      WHERE j.collected_meeting_id = c.collected_meeting_id AND cm.id = j.collected_meeting_id
      RETURNING j.collected_meeting_id, j.reason, j.attempts, j.created_at,
                cm.meet_code, cm.vexa_meeting_id, cm.workspace_id, cm.title, cm.started_at,
                cm.created_at AS requested_at, cm.episode_id`,
    [String(RECOVERY_LEASE_MIN)],
  );
  const row = r.rows[0];
  return row ? { ...row, episode_id: row.episode_id == null ? null : Number(row.episode_id) } : null;
}

export async function finishRecovery(
  pool: Pool, id: string,
  a: { status: 'done' | 'no_speech' | 'failed'; episodeId?: number | null; speechSeconds?: number | null; error?: string | null },
): Promise<void> {
  await pool.query(
    `UPDATE meeting_recovery_jobs
        SET status = $2, episode_id = COALESCE($3, episode_id), speech_seconds = COALESCE($4, speech_seconds),
            last_error = $5, claimed_at = NULL, updated_at = NOW()
      WHERE collected_meeting_id = $1`,
    [id, a.status, a.episodeId ?? null, a.speechSeconds ?? null, a.error ?? null],
  );
}

export async function retryRecovery(
  pool: Pool, id: string, a: { backoffSec: number; consumeAttempt: boolean; error: string },
): Promise<void> {
  await pool.query(
    `UPDATE meeting_recovery_jobs
        SET status = 'pending', scheduled_at = NOW() + ($2 || ' seconds')::interval,
            attempts = attempts + $3, last_error = $4, claimed_at = NULL, updated_at = NOW()
      WHERE collected_meeting_id = $1`,
    [id, String(a.backoffSec), a.consumeAttempt ? 1 : 0, a.error.slice(0, 1000)],
  );
}

export type SpeakerActivityRow = { speaker: string; started_at: Date; ended_at: Date };

export async function listSpeakerActivity(pool: Pool, vexaMeetingId: number): Promise<SpeakerActivityRow[]> {
  const r = await pool.query<SpeakerActivityRow>(
    `SELECT speaker, started_at, ended_at FROM meeting_speaker_activity
      WHERE vexa_meeting_id = $1 ORDER BY started_at`,
    [vexaMeetingId],
  );
  return r.rows;
}

export async function insertSpeakerActivity(
  pool: Pool, vexaMeetingId: number, events: Array<{ speaker: string; startMs: number; endMs: number }>,
): Promise<number> {
  if (events.length === 0) return 0;
  const vals: unknown[] = [vexaMeetingId];
  const rows = events.map((e, i) => {
    vals.push(e.speaker, new Date(e.startMs), new Date(e.endMs));
    return `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`;
  });
  const r = await pool.query(
    `INSERT INTO meeting_speaker_activity (vexa_meeting_id, speaker, started_at, ended_at) VALUES ${rows.join(', ')}`,
    vals,
  );
  return r.rowCount ?? 0;
}
