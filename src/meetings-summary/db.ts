/**
 * src/meetings-summary/db.ts
 *
 * Acesso a banco da fila de digest. Molde: os helpers de `transcription_jobs` em
 * src/db.ts, com uma diferença deliberada — o claim aqui usa LEASE explícito
 * (`status='processing'` + `claimed_at`) em vez do lease implícito por
 * `scheduled_at`, e a escrita final é condicionada à REVISÃO do episódio.
 * O porquê das duas coisas está na migration 063.
 */
import type { PoolClient } from 'pg';
import { pool } from '../db.js';
import type { MeetingDigest } from './prompt.js';

/** Quanto tempo um job claimado fica protegido de novo claim. Precisa ser bem
 *  MAIOR que o timeout de requisição do provider (90s) — senão o lease expira
 *  com a chamada ainda viva e duas execuções competem pela mesma escrita. */
export const LEASE_MINUTES = 5;







export type SummaryJob = {
  id: number;
  episode_id: number;
  episode_revision: number;
  status: string;
  attempts: number;
  created_at: Date;
};

/** episode_id é BIGINT: o driver pg devolve int8 como string. Normaliza no ponto
 *  de leitura (setTypeParser é global e mudaria o worker inteiro). */
function mapJob(row: any): SummaryJob {
  return {
    id: Number(row.id),
    episode_id: Number(row.episode_id),
    episode_revision: Number(row.episode_revision),
    status: row.status,
    attempts: Number(row.attempts),
    created_at: row.created_at,
  };
}

/**
 * Enfileira dentro da transação de quem chama — recebe o `client`, nunca abre
 * conexão própria. Assim o job só existe se o episódio existir: transação que
 * aborta não deixa job órfão apontando para episódio inexistente.
 */
export async function enqueueSummaryJobTx(
  client: PoolClient, episodeId: number, revision: number,
): Promise<void> {
  await client.query(
    `INSERT INTO meeting_summary_jobs (episode_id, episode_revision)
     VALUES ($1, $2)
     ON CONFLICT (episode_id) DO UPDATE
        SET episode_revision = EXCLUDED.episode_revision,
            status = 'pending',
            attempts = 0,
            scheduled_at = NOW(),
            claimed_at = NULL,
            last_error = NULL,
            updated_at = NOW()`,
    [episodeId, revision],
  );
}

const CLAIM_SQL = `
  WITH due AS (
    SELECT id FROM meeting_summary_jobs
     WHERE (status = 'pending'    AND scheduled_at <= NOW())
        OR (status = 'processing' AND claimed_at < NOW() - ($2 || ' minutes')::interval)
     ORDER BY scheduled_at ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED
  )
  UPDATE meeting_summary_jobs j
     SET attempts = j.attempts + 1,
         status = 'processing',
         claimed_at = NOW(),
         updated_at = NOW()
    FROM due WHERE j.id = due.id
  RETURNING j.id, j.episode_id, j.episode_revision, j.status, j.attempts, j.created_at`;

export async function claimDueSummaryJobs(batchSize: number): Promise<SummaryJob[]> {
  const { rows } = await pool.query(CLAIM_SQL, [batchSize, String(LEASE_MINUTES)]);
  return rows.map(mapJob);
}

export type EpisodeForSummary = {
  id: number;
  revision: number;
  title: string | null;
  duration_seconds: number | null;
  participants: Array<{ name?: string | null }>;
  turns: Array<{ speaker: string | null; text: string }>;
};

export async function loadEpisodeForSummary(episodeId: number): Promise<EpisodeForSummary | null> {
  const ep = await pool.query(
    `SELECT id, revision, title, duration_seconds, participants
       FROM episodes WHERE id = $1 AND fonte = 'reuniao'`,
    [episodeId],
  );
  const row = ep.rows[0];
  if (!row) return null;
  const turns = await pool.query(
    `SELECT speaker_name, text FROM episode_turns WHERE episode_id = $1 ORDER BY turn_index ASC`,
    [episodeId],
  );
  return {
    id: Number(row.id),
    revision: Number(row.revision),
    title: row.title,
    duration_seconds: row.duration_seconds,
    participants: Array.isArray(row.participants) ? row.participants : [],
    turns: turns.rows.map((t: any) => ({ speaker: t.speaker_name, text: String(t.text ?? '') })),
  };
}

/**
 * Grava o digest e conclui o job NA MESMA TRANSAÇÃO, condicionado à revisão.
 *
 * Duas coisas de uma vez, e as duas importam:
 *   - atômico: crash entre gravar o digest e concluir o job repetiria a chamada
 *     (e o custo); na ordem inversa, perderia o digest;
 *   - condicionado: `WHERE revision = $` descarta a escrita de uma execução que
 *     ficou obsoleta porque um `force` reimportou o episódio no meio do caminho.
 *
 * Devolve `false` quando a revisão não bate — o chamador NÃO deve tratar como
 * erro: o job já foi reenfileirado pelo `force` e a revisão nova será resumida.
 */
export async function finishSummaryJob(a: {
  jobId: number; episodeId: number; revision: number; digest: MeetingDigest; model: string;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE episodes
          SET summary = $2, summary_points = $3, summary_model = $4,
              summary_generated_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND revision = $5`,
      [a.episodeId, a.digest.summary, JSON.stringify(a.digest.points), a.model, a.revision],
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `UPDATE meeting_summary_jobs
          SET status = 'done', last_error = NULL, claimed_at = NULL, updated_at = NOW()
        WHERE id = $1 AND episode_revision = $2`,
      [a.jobId, a.revision],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Job que não produziu digest mas também não deve ser retentado (episódio sem
 *  turnos, ou modelo declarando que não há o que resumir). */
export async function closeSummaryJobEmpty(jobId: number, reason: string): Promise<void> {
  await pool.query(
    `UPDATE meeting_summary_jobs
        SET status = 'done', last_error = $2, claimed_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [jobId, reason],
  );
}

/** Devolve o job à fila com backoff. `consumeAttempt=false` (falha de AMBIENTE)
 *  desfaz o +1 que o claim somou — senão o apagão puniria justamente os jobs que
 *  a política quer proteger. */
export async function rescheduleSummaryJob(
  jobId: number, backoffSec: number, err: string, consumeAttempt: boolean,
): Promise<void> {
  await pool.query(
    `UPDATE meeting_summary_jobs
        SET status = 'pending',
            claimed_at = NULL,
            attempts = CASE WHEN $4 THEN attempts ELSE GREATEST(attempts - 1, 0) END,
            scheduled_at = NOW() + ($2 || ' seconds')::interval,
            last_error = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [jobId, String(backoffSec), err.slice(0, 500), consumeAttempt],
  );
}

export async function failSummaryJob(jobId: number, err: string): Promise<void> {
  await pool.query(
    `UPDATE meeting_summary_jobs
        SET status = 'failed', last_error = $2, claimed_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [jobId, err.slice(0, 500)],
  );
}

/** Enfileira episódios de reunião ainda sem digest — base do backfill. `redo`
 *  inclui os que já têm. Usa a mesma tabela e o mesmo poller: sem política
 *  paralela de backfill. */
export async function enqueuePendingEpisodes(a: { limit: number; redo: boolean }): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO meeting_summary_jobs (episode_id, episode_revision)
     SELECT e.id, e.revision
       FROM episodes e
      WHERE e.fonte = 'reuniao' AND e.turn_count > 0
        AND ($2::bool OR e.summary IS NULL)
      ORDER BY e.occurred_at DESC
      LIMIT $1
     ON CONFLICT (episode_id) DO UPDATE
        SET episode_revision = EXCLUDED.episode_revision,
            status = 'pending', attempts = 0, scheduled_at = NOW(),
            claimed_at = NULL, last_error = NULL, updated_at = NOW()
     RETURNING id`,
    [a.limit, a.redo],
  );
  return rows.length;
}

/** Enfileira UM episódio específico (`--episode=<id>` do CLI). */
export async function enqueueOneEpisode(episodeId: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO meeting_summary_jobs (episode_id, episode_revision)
     SELECT e.id, e.revision FROM episodes e
      WHERE e.id = $1 AND e.fonte = 'reuniao' AND e.turn_count > 0
     ON CONFLICT (episode_id) DO UPDATE
        SET episode_revision = EXCLUDED.episode_revision,
            status = 'pending', attempts = 0, scheduled_at = NOW(),
            claimed_at = NULL, last_error = NULL, updated_at = NOW()`,
    [episodeId],
  );
  return (rowCount ?? 0) > 0;
}

export async function countPendingSummaryJobs(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM meeting_summary_jobs WHERE status IN ('pending','processing')`,
  );
  return rows[0]?.n ?? 0;
}
