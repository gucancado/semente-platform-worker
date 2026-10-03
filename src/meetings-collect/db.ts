import type { Pool } from 'pg';
import type { ReusePatch } from './reuse.js';

export type CollectedMeetingStatus = 'queued' | 'collecting' | 'stopping' | 'imported' | 'failed' | 'canceled';

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
  title: string | null;
  queue_expires_at: Date | null;
  /** Quando a promoção enviou o bot (mig 065). Nulo antes disso e em rows antigas. */
  started_at: Date | null;
  /** Diagnóstico (mig 069): último status lido do Vexa, quando, a trilha das
   *  mudanças e o texto do erro da falha. */
  vexa_status: string | null;
  vexa_status_at: Date | null;
  failure_detail: string | null;
  status_log: unknown;
  created_at: Date;
  updated_at: Date;
};

const COLS = `id, meet_code, vexa_meeting_id, workspace_id, status, failure_reason,
              requested_by, last_segment_at, episode_id, title, queue_expires_at,
              started_at, vexa_status, vexa_status_at, failure_detail, status_log,
              created_at, updated_at`;

/** episode_id é BIGINT e o driver pg entrega int8 como string (sem setTypeParser,
 *  que é global e mudaria o worker inteiro). Normaliza aqui, no ponto de leitura,
 *  para o tipo declarado ser verdade e o contrato meetings_v1 (episode_id: number)
 *  valer na resposta HTTP. vexa_meeting_id é INT (int4) e já chega number. */
export function mapCollectedMeetingRow(row: CollectedMeetingRow): CollectedMeetingRow {
  return { ...row, episode_id: row.episode_id == null ? null : Number(row.episode_id) };
}

export async function createCollectedMeeting(
  pool: Pool,
  a: { meetCode: string; workspaceId: string | null; requestedBy: string; title?: string | null; queueExpiresAt?: Date | null },
): Promise<CollectedMeetingRow> {
  const { rows } = await pool.query<CollectedMeetingRow>(
    `INSERT INTO collected_meetings (meet_code, workspace_id, requested_by, title, queue_expires_at, status)
     VALUES ($1, $2, $3, $4, $5, 'queued')
     RETURNING ${COLS}`,
    [a.meetCode, a.workspaceId, a.requestedBy, a.title ?? null, a.queueExpiresAt ?? null],
  );
  return mapCollectedMeetingRow(rows[0]!);
}

/**
 * Cria a coleta OU reaproveita a ativa (queued|collecting|stopping) com o mesmo
 * meet_code, de qualquer workspace — o Vexa é por sala e recusa 2º bot nela (ver
 * reuse.ts). Transação com advisory lock por meet_code: dois POSTs simultâneos
 * para a mesma sala serializam aqui, e o segundo enxerga a row do primeiro em vez
 * de criar outra. O FOR UPDATE segura a row contra o poller no meio do caminho
 * (que pode estar marcando-a terminal); se ele ganhar, o SELECT não a vê e cria nova.
 */
export async function createOrReuseCollectedMeeting(
  pool: Pool,
  a: { meetCode: string; workspaceId: string | null; requestedBy: string; title?: string | null; queueExpiresAt?: Date | null },
  plan: (existing: CollectedMeetingRow) => ReusePatch,
): Promise<{ row: CollectedMeetingRow; reused: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`meetings-collect:${a.meetCode}`]);
    const found = await client.query<CollectedMeetingRow>(
      `SELECT ${COLS} FROM collected_meetings
        WHERE meet_code = $1 AND status IN ('queued','collecting','stopping')
        ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
      [a.meetCode],
    );
    if (found.rows[0]) {
      const existing = mapCollectedMeetingRow(found.rows[0]);
      const p = plan(existing);
      // COALESCE/GREATEST no SQL repetem as guardas do plano: o plano decide, o
      // banco garante que nunca recua âncora/validade nem sobrescreve o preenchido.
      const { rows } = await client.query<CollectedMeetingRow>(
        `UPDATE collected_meetings SET
            queue_expires_at = CASE WHEN $2::timestamptz IS NULL THEN queue_expires_at
                                    ELSE GREATEST(COALESCE(queue_expires_at, $2::timestamptz), $2::timestamptz) END,
            started_at = CASE WHEN $3::timestamptz IS NULL THEN started_at
                              ELSE GREATEST(COALESCE(started_at, $3::timestamptz), $3::timestamptz) END,
            title = COALESCE(title, $4),
            workspace_id = COALESCE(workspace_id, $5),
            updated_at = NOW()
          WHERE id = $1
          RETURNING ${COLS}`,
        [existing.id, p.queueExpiresAt ?? null, p.startedAt ?? null, p.title ?? null, p.workspaceId ?? null],
      );
      await client.query('COMMIT');
      return { row: mapCollectedMeetingRow(rows[0]!), reused: true };
    }
    const { rows } = await client.query<CollectedMeetingRow>(
      `INSERT INTO collected_meetings (meet_code, workspace_id, requested_by, title, queue_expires_at, status)
       VALUES ($1, $2, $3, $4, $5, 'queued')
       RETURNING ${COLS}`,
      [a.meetCode, a.workspaceId, a.requestedBy, a.title ?? null, a.queueExpiresAt ?? null],
    );
    await client.query('COMMIT');
    return { row: mapCollectedMeetingRow(rows[0]!), reused: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** GLOBAL: existe alguma coleta ativa (Vexa Lite = 1 simultânea). */
export async function getActiveCollectedMeeting(pool: Pool): Promise<CollectedMeetingRow | null> {
  const { rows } = await pool.query<CollectedMeetingRow>(
    `SELECT ${COLS} FROM collected_meetings
      WHERE status IN ('collecting','stopping') ORDER BY created_at ASC LIMIT 1`,
  );
  return rows[0] ? mapCollectedMeetingRow(rows[0]) : null;
}

export async function getCollectedMeeting(pool: Pool, id: string): Promise<CollectedMeetingRow | null> {
  const { rows } = await pool.query<CollectedMeetingRow>(
    `SELECT ${COLS} FROM collected_meetings WHERE id=$1`, [id]);
  return rows[0] ? mapCollectedMeetingRow(rows[0]) : null;
}

export async function listActiveCollectedMeetings(pool: Pool): Promise<CollectedMeetingRow[]> {
  const { rows } = await pool.query<CollectedMeetingRow>(
    `SELECT ${COLS} FROM collected_meetings
      WHERE status IN ('collecting','stopping') ORDER BY created_at ASC`);
  return rows.map(mapCollectedMeetingRow);
}

/** Coletas consumindo slot AGORA (bot no ar): collecting/stopping. Queued não conta. */
export async function countActiveCollections(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM collected_meetings WHERE status IN ('collecting','stopping')`,
  );
  return Number(rows[0]!.n);
}

/** Fila FIFO de coletas aguardando slot. */
export async function listQueuedMeetings(pool: Pool): Promise<CollectedMeetingRow[]> {
  const { rows } = await pool.query<CollectedMeetingRow>(
    `SELECT ${COLS} FROM collected_meetings WHERE status = 'queued' ORDER BY created_at ASC`,
  );
  return rows.map(mapCollectedMeetingRow);
}

export async function updateCollectedMeeting(
  pool: Pool,
  id: string,
  patch: {
    status?: string; failureReason?: string | null; episodeId?: number | null; vexaMeetingId?: number | null;
    lastSegmentAt?: Date | null; startedAt?: Date | null;
    vexaStatus?: string | null; vexaStatusAt?: Date | null; failureDetail?: string | null; statusLog?: unknown[];
  },
): Promise<void> {
  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];
  const add = (col: string, val: unknown) => { vals.push(val); sets.push(`${col} = $${vals.length + 1}`); };
  if (patch.status !== undefined) add('status', patch.status);
  if (patch.failureReason !== undefined) add('failure_reason', patch.failureReason);
  if (patch.episodeId !== undefined) add('episode_id', patch.episodeId);
  if (patch.vexaMeetingId !== undefined) add('vexa_meeting_id', patch.vexaMeetingId);
  if (patch.lastSegmentAt !== undefined) add('last_segment_at', patch.lastSegmentAt);
  if (patch.startedAt !== undefined) add('started_at', patch.startedAt);
  if (patch.vexaStatus !== undefined) add('vexa_status', patch.vexaStatus);
  if (patch.vexaStatusAt !== undefined) add('vexa_status_at', patch.vexaStatusAt);
  if (patch.failureDetail !== undefined) add('failure_detail', patch.failureDetail);
  if (patch.statusLog !== undefined) add('status_log', JSON.stringify(patch.statusLog));
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
