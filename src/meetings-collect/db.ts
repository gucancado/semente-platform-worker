import type { Pool } from 'pg';

export type CollectedMeetingStatus = 'collecting' | 'stopping' | 'imported' | 'failed' | 'canceled';

export type CollectedMeetingRow = {
  id: string;
  meet_code: string;
  vexa_meeting_id: number | null;
  workspace_id: string | null;
  status: CollectedMeetingStatus;
  failure_reason: string | null;
  requested_by: string;
  last_segment_at: Date | null;
  episode_id: number | null;
  created_at: Date;
  updated_at: Date;
};

const COLS = `id, meet_code, vexa_meeting_id, workspace_id, status, failure_reason,
              requested_by, last_segment_at, episode_id, created_at, updated_at`;

export async function createCollectedMeeting(
  pool: Pool,
  a: { meetCode: string; workspaceId: string | null; requestedBy: string },
): Promise<CollectedMeetingRow> {
  const { rows } = await pool.query<CollectedMeetingRow>(
    `INSERT INTO collected_meetings (meet_code, workspace_id, requested_by, status)
     VALUES ($1,$2,$3,'collecting') RETURNING ${COLS}`,
    [a.meetCode, a.workspaceId, a.requestedBy],
  );
  return rows[0]!;
}

/** GLOBAL: existe alguma coleta ativa (Vexa Lite = 1 simultânea). */
export async function getActiveCollectedMeeting(pool: Pool): Promise<CollectedMeetingRow | null> {
  const { rows } = await pool.query<CollectedMeetingRow>(
    `SELECT ${COLS} FROM collected_meetings
      WHERE status IN ('collecting','stopping') ORDER BY created_at ASC LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function getCollectedMeeting(pool: Pool, id: string): Promise<CollectedMeetingRow | null> {
  const { rows } = await pool.query<CollectedMeetingRow>(
    `SELECT ${COLS} FROM collected_meetings WHERE id=$1`, [id]);
  return rows[0] ?? null;
}

export async function listActiveCollectedMeetings(pool: Pool): Promise<CollectedMeetingRow[]> {
  const { rows } = await pool.query<CollectedMeetingRow>(
    `SELECT ${COLS} FROM collected_meetings
      WHERE status IN ('collecting','stopping') ORDER BY created_at ASC`);
  return rows;
}

export async function updateCollectedMeeting(
  pool: Pool,
  id: string,
  patch: { status?: string; failureReason?: string | null; episodeId?: number | null; vexaMeetingId?: number | null; lastSegmentAt?: Date | null },
): Promise<void> {
  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];
  const add = (col: string, val: unknown) => { vals.push(val); sets.push(`${col} = $${vals.length + 1}`); };
  if (patch.status !== undefined) add('status', patch.status);
  if (patch.failureReason !== undefined) add('failure_reason', patch.failureReason);
  if (patch.episodeId !== undefined) add('episode_id', patch.episodeId);
  if (patch.vexaMeetingId !== undefined) add('vexa_meeting_id', patch.vexaMeetingId);
  if (patch.lastSegmentAt !== undefined) add('last_segment_at', patch.lastSegmentAt);
  await pool.query(`UPDATE collected_meetings SET ${sets.join(', ')} WHERE id = $1`, [id, ...vals]);
}

/** Congelado sse já existe fato destilado (Lua) para o episódio. */
export async function isEpisodeFrozen(pool: Pool, episodeId: number): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM facts WHERE episode_id=$1 LIMIT 1', [episodeId]);
  return rows.length > 0;
}

/** Re-atribui o episódio; o trigger trg_lua_propagate_workspace cuida das tabelas derivadas. */
export async function reattributeEpisode(pool: Pool, episodeId: number, workspaceId: string): Promise<void> {
  await pool.query('UPDATE episodes SET workspace_id=$2, updated_at=NOW() WHERE id=$1', [episodeId, workspaceId]);
}
