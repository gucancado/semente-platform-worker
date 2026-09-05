import type { Pool } from 'pg';

export type MeetingListRow = {
  collected_id: string | null;
  episode_id: number;
  meet_code: string | null;
  status: string;
  failure_reason: string | null;
  title: string | null;
  occurred_at: Date | null;
  duration_seconds: number | null;
  participants: Array<{ name: string; email: string | null }> | null;
  summary: string | null;
  /** Falantes REAIS do episódio, com tempo de fala. Vem daqui e não dos
   *  `participants` porque as duas listas divergem: no Fireflies o participante
   *  tem só email e o falante só nome, e há quem fale sem constar da lista de
   *  convidados (medido: 1.114 participantes sem fala correspondente em 218
   *  episódios). Quem cruza os dois é o painel, via membros do workspace. */
  speakers: Array<{ name: string; seconds: number; turns: number }> | null;
  sort_at: Date;
};

/** episode_id é BIGINT: o driver pg devolve int8 como string. Normaliza no ponto de leitura
 *  (setTypeParser é global e mudaria o worker inteiro). */
export function mapMeetingListRow(row: MeetingListRow): MeetingListRow {
  return { ...row, episode_id: Number(row.episode_id) };
}

// Lista dirigida por EPISODES (toda reunião transcrita: fireflies importadas + vexa),
// LEFT JOIN collected_meetings pra trazer o status/failure da coleta Vexa quando existir.
// Episódio sem linha de coleta (fireflies) = 'transcribed'. Fronteira de dia em BRT.
const LIST_SQL = `
  WITH m AS (
    SELECT e.id AS episode_id, cm.id AS collected_id, cm.meet_code,
           COALESCE(cm.status, 'transcribed') AS status, cm.failure_reason,
           e.title, e.occurred_at, e.duration_seconds, e.participants, e.summary,
           e.occurred_at AS sort_at
    FROM episodes e
    LEFT JOIN collected_meetings cm ON cm.episode_id = e.id
    WHERE e.fonte = 'reuniao' AND e.workspace_id = $1
  ), sp AS (
    -- Agregado por falante. started_at_ms/ended_at_ms está populado em 100% dos
    -- turnos das duas fontes (medido), então o tempo é confiável; ainda assim o
    -- COALESCE protege contra turno sem marcação, que renderia negativo.
    -- (Sem crase neste comentário: ele vive dentro de um template literal.)
    SELECT x.episode_id,
           jsonb_agg(jsonb_build_object('name', x.speaker_name, 'seconds', x.seconds, 'turns', x.turns)
                     ORDER BY x.seconds DESC) AS speakers
    FROM (
      SELECT et.episode_id, et.speaker_name,
             round(sum(GREATEST(COALESCE(et.ended_at_ms,0) - COALESCE(et.started_at_ms,0), 0)) / 1000.0)::int AS seconds,
             count(*)::int AS turns
      FROM episode_turns et
      JOIN m ON m.episode_id = et.episode_id
      WHERE et.speaker_name IS NOT NULL
      GROUP BY et.episode_id, et.speaker_name
    ) x
    GROUP BY x.episode_id
  )
  SELECT m.*, sp.speakers FROM m LEFT JOIN sp ON sp.episode_id = m.episode_id
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
  total_seconds: number;
  avg_seconds: number;
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
  WHERE fonte='reuniao' AND workspace_id=$1
    AND occurred_at >= ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
    AND occurred_at <  ($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'`;

const DAILY_SQL = `
  SELECT to_char((occurred_at AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS day, count(*)::int AS n
  FROM episodes
  WHERE fonte='reuniao' AND workspace_id=$1
    AND occurred_at >= ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
    AND occurred_at <  ($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'
  GROUP BY 1 ORDER BY 1`;

// Participação agregada dos TURNS (universal: fireflies não populou metadata.speaker_counts,
// mas todo episódio de reunião tem episode_turns com speaker_name). "segments" = nº de turnos.
const SPEAKERS_SQL = `
  SELECT et.speaker_name AS speaker, count(*)::int AS segments
  FROM episode_turns et
  JOIN episodes e ON e.id = et.episode_id
  WHERE e.fonte='reuniao' AND e.workspace_id=$1 AND et.speaker_name IS NOT NULL
    AND e.occurred_at >= ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
    AND e.occurred_at <  ($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'
  GROUP BY et.speaker_name ORDER BY segments DESC`;

const HEALTH_SQL = `
  SELECT status, count(*)::int AS n
  FROM collected_meetings
  WHERE workspace_id=$1
    AND created_at >= ($2::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
    AND created_at <  ($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'
  GROUP BY status`;

/** Cabeçalho + digest, SEM os turnos. Existe porque o digest é visível a
 *  qualquer membro do workspace mas a transcrição bruta continua admin-only:
 *  ocultar os turnos no render não bastaria, eles não podem sequer trafegar. */
export type MeetingDigestView = {
  id: number; title: string | null; occurred_at: Date; duration_seconds: number | null;
  participants: Array<{ name: string; email: string | null }>;
  summary: string | null; summary_points: string[] | null; summary_generated_at: Date | null;
};

/** `summary_points` é jsonb: o driver devolve o que estiver gravado, e uma row
 *  legada/mexida à mão pode não ser array. Normaliza aqui, na fronteira de
 *  leitura, para o consumidor nunca receber algo que quebre um `.map`. */
function coercePoints(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  return out.length ? out : null;
}

function mapDigestView(row: any): MeetingDigestView {
  return {
    id: Number(row.id), title: row.title, occurred_at: row.occurred_at,
    duration_seconds: row.duration_seconds, participants: row.participants ?? [],
    summary: row.summary ?? null,
    summary_points: coercePoints(row.summary_points),
    summary_generated_at: row.summary_generated_at ?? null,
  };
}

/** Só o cabeçalho + digest, sem turnos e sem tocar em episode_turns. */
export async function getMeetingDigest(
  pool: Pool, a: { episodeId: number; workspaceId: string },
): Promise<MeetingDigestView | null> {
  const { rows } = await pool.query(
    `SELECT id, title, occurred_at, duration_seconds, participants, workspace_id,
            summary, summary_points, summary_generated_at
     FROM episodes WHERE id=$1 AND fonte='reuniao'`, [a.episodeId]);
  const row = rows[0];
  // Mesma revalidação de tenant do transcript: episódio de outro workspace → null.
  if (!row || row.workspace_id !== a.workspaceId) return null;
  return mapDigestView(row);
}

export type MeetingTranscript = {
  episode: MeetingDigestView;
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
    `SELECT id, title, occurred_at, duration_seconds, participants, workspace_id,
            summary, summary_points, summary_generated_at
     FROM episodes WHERE id=$1 AND fonte='reuniao'`, [a.episodeId]);
  const row = ep.rows[0];
  // Revalidação de tenant: episódio inexistente OU de outro workspace → null (404 na rota).
  if (!row || row.workspace_id !== a.workspaceId) return null;
  const turns = await pool.query(
    `SELECT turn_index, speaker_name, started_at_ms, ended_at_ms, text
     FROM episode_turns WHERE episode_id=$1 ORDER BY turn_index ASC`, [a.episodeId]);
  return {
    episode: mapDigestView(row),
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
    total_seconds: t.total_seconds,
    avg_seconds: Math.round(t.avg_seconds),
    daily: fillDailySeries(daily.rows.map((r) => ({ day: r.day, count: r.n })), a.since, a.until),
    speakers: speakers.rows.map((r) => ({ speaker: r.speaker, segments: r.segments })),
    health: Object.fromEntries(health.rows.map((r) => [r.status, r.n])),
  };
}
