import type { Pool } from 'pg';
import { PENDING_WINDOW_HOURS } from './core.js';

export type PendingAudio = { episodeId: number; vexaMeetingId: number; episodeDurationS: number | null };

/** Reuniões da Vexa importadas recentemente cujo episódio ainda não tem áudio. */
export async function listPendingAudio(
  pool: Pool, a: { windowHours?: number; limit?: number } = {},
): Promise<PendingAudio[]> {
  const { rows } = await pool.query(
    `SELECT cm.episode_id, cm.vexa_meeting_id, e.duration_seconds
       FROM collected_meetings cm
       JOIN episodes e ON e.id = cm.episode_id
      WHERE cm.status = 'imported'
        AND cm.vexa_meeting_id IS NOT NULL
        AND e.audio_r2_key IS NULL
        AND cm.updated_at > now() - make_interval(hours => $1)
      ORDER BY cm.updated_at ASC
      LIMIT $2`,
    [a.windowHours ?? PENDING_WINDOW_HOURS, a.limit ?? 10],
  );
  return rows.map((r) => ({
    episodeId: Number(r.episode_id), vexaMeetingId: Number(r.vexa_meeting_id),
    episodeDurationS: r.duration_seconds == null ? null : Number(r.duration_seconds),
  }));
}

/** Episódio importado de uma reunião da Vexa. Usado pelo backfill das gravações
 *  antigas, que chegam pelo id da Vexa no nome do arquivo. */
export async function findEpisodeForVexaMeeting(
  pool: Pool, vexaMeetingId: number,
): Promise<{ episodeId: number; hasAudio: boolean; durationS: number | null } | null> {
  const { rows } = await pool.query(
    `SELECT e.id, e.audio_r2_key, e.duration_seconds
       FROM collected_meetings cm
       JOIN episodes e ON e.id = cm.episode_id
      WHERE cm.vexa_meeting_id = $1
      LIMIT 1`,
    [vexaMeetingId],
  );
  const r = rows[0];
  return r ? {
    episodeId: Number(r.id), hasAudio: r.audio_r2_key != null,
    durationS: r.duration_seconds == null ? null : Number(r.duration_seconds),
  } : null;
}

/** Grava a chave só se ainda não houver uma: execuções concorrentes (poller e
 *  backfill) não sobrescrevem o que a outra já registrou. */
export async function setEpisodeAudioKey(pool: Pool, episodeId: number, key: string, audioStartMs = 0): Promise<boolean> {
  const r = await pool.query(
    `UPDATE episodes SET audio_r2_key = $2, updated_at = now(),
            metadata = metadata || jsonb_build_object('audio_start_ms', $3::int)
      WHERE id = $1 AND audio_r2_key IS NULL`,
    [episodeId, key, audioStartMs],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Chave do áudio com revalidação de tenant: episódio de outro workspace → null. */
export async function getEpisodeAudio(
  pool: Pool, a: { episodeId: number; workspaceId: string },
): Promise<{ key: string; occurredAt: Date } | null> {
  const { rows } = await pool.query(
    `SELECT audio_r2_key, occurred_at, workspace_id
       FROM episodes WHERE id = $1 AND fonte = 'reuniao'`,
    [a.episodeId],
  );
  const r = rows[0];
  if (!r || r.workspace_id !== a.workspaceId || !r.audio_r2_key) return null;
  return { key: r.audio_r2_key, occurredAt: r.occurred_at };
}
