import type { Pool } from 'pg';

export type MeetingListRow = {
  collected_id: string;
  episode_id: number | null;
  meet_code: string;
  status: string;
  failure_reason: string | null;
  title: string | null;
  occurred_at: Date | null;
  duration_seconds: number | null;
  participants: Array<{ name: string; email: string | null }> | null;
  sort_at: Date;
};

/** episode_id é BIGINT: o driver pg devolve int8 como string. Normaliza no ponto de leitura
 *  (setTypeParser é global e mudaria o worker inteiro). */
export function mapMeetingListRow(row: MeetingListRow): MeetingListRow {
  return { ...row, episode_id: row.episode_id == null ? null : Number(row.episode_id) };
}

// Fronteira de dia em America/Sao_Paulo: $2/$3 são datas YYYY-MM-DD (ou null).
const LIST_SQL = `
  WITH m AS (
    SELECT cm.id AS collected_id, cm.episode_id, cm.meet_code, cm.status, cm.failure_reason,
           e.title, e.occurred_at, e.duration_seconds, e.participants,
           COALESCE(e.occurred_at, cm.created_at) AS sort_at
    FROM collected_meetings cm
    LEFT JOIN episodes e ON e.id = cm.episode_id
    WHERE cm.workspace_id = $1
  )
  SELECT * FROM m
  WHERE ($2::date IS NULL OR sort_at >= ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo')
    AND ($3::date IS NULL OR sort_at <  ($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
  ORDER BY sort_at DESC
  LIMIT $4`;

export async function listMeetings(
  pool: Pool,
  a: { workspaceId: string; since?: string | null; until?: string | null; limit?: number },
): Promise<MeetingListRow[]> {
  const { rows } = await pool.query<MeetingListRow>(LIST_SQL, [
    a.workspaceId, a.since ?? null, a.until ?? null, a.limit ?? 200,
  ]);
  return rows.map(mapMeetingListRow);
}
