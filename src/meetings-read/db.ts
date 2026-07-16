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

export type MeetingsStats = {
  total: number;
  totalSeconds: number;
  avgSeconds: number;
  daily: Array<{ day: string; count: number }>;
  speakers: Array<{ speaker: string; segments: number }>;
  health: Record<string, number>;
};

/** Preenche dias sem reunião com zero. `since`/`until` são YYYY-MM-DD inclusivos.
 *  Usa aritmética de string de data (UTC-safe) — nunca new Date('YYYY-MM-DD') local. */
export function fillDailySeries(
  rows: Array<{ day: string; count: number }>,
  since: string,
  until: string,
): Array<{ day: string; count: number }> {
  const byDay = new Map(rows.map((r) => [r.day, r.count]));
  const out: Array<{ day: string; count: number }> = [];
  let cur = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  while (cur <= end) {
    const day = cur.toISOString().slice(0, 10);
    out.push({ day, count: byDay.get(day) ?? 0 });
    cur = new Date(cur.getTime() + 86_400_000);
  }
  return out;
}

const TOTALS_SQL = `
  SELECT count(*)::int AS n,
         COALESCE(sum(duration_seconds),0)::int AS total_seconds,
         COALESCE(avg(duration_seconds),0)::float AS avg_seconds
  FROM episodes
  WHERE external_source='vexa' AND workspace_id=$1
    AND occurred_at >= ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
    AND occurred_at <  ($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'`;

const DAILY_SQL = `
  SELECT to_char((occurred_at AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS day, count(*)::int AS n
  FROM episodes
  WHERE external_source='vexa' AND workspace_id=$1
    AND occurred_at >= ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
    AND occurred_at <  ($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'
  GROUP BY 1 ORDER BY 1`;

const SPEAKERS_SQL = `
  SELECT sk.key AS speaker, SUM((sk.value)::int)::int AS segments
  FROM episodes e, jsonb_each_text(e.metadata->'speaker_counts') AS sk
  WHERE e.external_source='vexa' AND e.workspace_id=$1 AND e.metadata ? 'speaker_counts'
    AND e.occurred_at >= ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
    AND e.occurred_at <  ($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'
  GROUP BY sk.key ORDER BY segments DESC`;

const HEALTH_SQL = `
  SELECT status, count(*)::int AS n
  FROM collected_meetings
  WHERE workspace_id=$1
    AND created_at >= ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
    AND created_at <  ($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'
  GROUP BY status`;

export type MeetingTranscript = {
  episode: {
    id: number; title: string | null; occurred_at: Date; duration_seconds: number | null;
    participants: Array<{ name: string; email: string | null }>;
  };
  turns: Array<{
    turn_index: number; speaker_name: string | null;
    started_at_ms: number | null; ended_at_ms: number | null; text: string;
  }>;
};

export async function getMeetingTranscript(
  pool: Pool,
  a: { episodeId: number; workspaceId: string },
): Promise<MeetingTranscript | null> {
  const ep = await pool.query(
    `SELECT id, title, occurred_at, duration_seconds, participants, workspace_id
     FROM episodes WHERE id=$1`, [a.episodeId]);
  const row = ep.rows[0];
  // Revalidação de tenant: episódio inexistente OU de outro workspace → null (404 na rota).
  if (!row || row.workspace_id !== a.workspaceId) return null;
  const turns = await pool.query(
    `SELECT turn_index, speaker_name, started_at_ms, ended_at_ms, text
     FROM episode_turns WHERE episode_id=$1 ORDER BY turn_index ASC`, [a.episodeId]);
  return {
    episode: {
      id: Number(row.id), title: row.title, occurred_at: row.occurred_at,
      duration_seconds: row.duration_seconds, participants: row.participants ?? [],
    },
    turns: turns.rows.map((r) => ({
      turn_index: r.turn_index, speaker_name: r.speaker_name,
      started_at_ms: r.started_at_ms, ended_at_ms: r.ended_at_ms, text: r.text,
    })),
  };
}

export async function getMeetingsStats(
  pool: Pool,
  a: { workspaceId: string; since: string; until: string },
): Promise<MeetingsStats> {
  const p = [a.workspaceId, a.since, a.until];
  const [totals, daily, speakers, health] = await Promise.all([
    pool.query(TOTALS_SQL, p),
    pool.query<{ day: string; n: number }>(DAILY_SQL, p),
    pool.query<{ speaker: string; segments: number }>(SPEAKERS_SQL, p),
    pool.query<{ status: string; n: number }>(HEALTH_SQL, p),
  ]);
  const t = totals.rows[0] ?? { n: 0, total_seconds: 0, avg_seconds: 0 };
  return {
    total: t.n,
    totalSeconds: t.total_seconds,
    avgSeconds: Math.round(t.avg_seconds),
    daily: fillDailySeries(daily.rows.map((r) => ({ day: r.day, count: r.n })), a.since, a.until),
    speakers: speakers.rows.map((r) => ({ speaker: r.speaker, segments: r.segments })),
    health: Object.fromEntries(health.rows.map((r) => [r.status, r.n])),
  };
}
