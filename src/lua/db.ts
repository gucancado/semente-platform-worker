import type { PoolClient } from 'pg';
import { pool } from '../db.js';

// Máximo de tentativas antes de marcar um episódio como `dead` (spec §5.2/§7).
// Constante fixa nesta task — sem env de config (decisão do escopo da Task 4).
export const LUA_MAX_ATTEMPTS = 4;

// ── Tipos de linha / entrada ──────────────────────────────────────────────

export type ProcessingStatus =
  | 'pending'
  | 'chunked'
  | 'done'
  | 'failed'
  | 'dead'
  | 'skipped';

export type ProcessingRow = {
  id: number;
  episode_id: number;
  episode_revision: number;
  status: ProcessingStatus;
  attempt_count: number;
  next_attempt_at: Date;
  claimed_at: Date | null;
  claimed_by: string | null;
  last_error: string | null;
  stats: Record<string, unknown>;
  processed_at: Date | null;
  created_at: Date;
};

export type ChunkInput = {
  chunkIndex: number;
  turnStart: number;
  turnEnd: number;
  charStart: number | null;
  charEnd: number | null;
  text: string;
  tokenCount: number;
  embedding: number[];
  embeddingModel: string;
};

export type FactInput = {
  workspaceId: string;
  factType: string;
  statement: string;
  attributes?: Record<string, unknown>;
  confidence: number;
  validAt: Date | string;
  episodeId: number;
  episodeRevision: number;
  turnStart: number;
  turnEnd: number;
  embedding: number[];
  embeddingModel: string;
  extractedBy: string;
  runId?: number | null;
  needsReview?: boolean;
  reviewNote?: string | null;
  invalidAt?: Date | string | null;
  invalidationReason?: string | null;
  supersededByFactId?: number | null;
};

export type NeighborRow = {
  id: number;
  statement: string;
  valid_at: Date;
  similarity: number;
};

export type RunKind = 'nightly' | 'bootstrap' | 'manual';
export type RunStatus = 'running' | 'done' | 'failed';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Serializa um vetor JS no literal aceito pelo pgvector: '[a,b,c]'. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

// ── 1. Varredura / enqueue (spec §5.2) ────────────────────────────────────

/**
 * Enfileira episódios elegíveis: workspace_id NÃO nulo e ainda sem linha em
 * lua_processing para a revision atual. Órfão (workspace_id NULL) nunca entra.
 * ON CONFLICT DO NOTHING absorve corrida. Retorna quantidade inserida.
 */
export async function enqueueEligibleEpisodes(): Promise<number> {
  const { rowCount } = await pool.query(
    `INSERT INTO lua_processing (episode_id, episode_revision)
     SELECT e.id, e.revision
       FROM episodes e
       LEFT JOIN lua_processing p
         ON p.episode_id = e.id AND p.episode_revision = e.revision
      WHERE e.workspace_id IS NOT NULL
        AND p.id IS NULL
     ON CONFLICT DO NOTHING`
  );
  return rowCount ?? 0;
}

// ── 2. Claim com lease + guarda de revision + ordem occurred_at (spec §5.3) ─

/**
 * Reivindica até `batch` episódios devidos, com:
 *  - FOR UPDATE OF lp SKIP LOCKED (concorrência);
 *  - lease de 15min (claim vencido é retomável);
 *  - guarda de revision (linha cuja revision ficou pra trás NUNCA é selecionada);
 *  - ordem cronológica do mundo (episodes.occurred_at ASC) — minimiza supersede retroativo.
 */
export async function claimProcessing(
  workerId: string,
  batch: number
): Promise<ProcessingRow[]> {
  // CTE materializa o conjunto travado ANTES do UPDATE (padrão webhook_receipts /
  // outbox). Sem a CTE, o `FOR UPDATE ... SKIP LOCKED` num subquery IN da mesma
  // tabela do UPDATE interage com os locks do próprio UPDATE e pode pular linhas.
  // RETURNING de UPDATE...FROM não garante ordem → ordenamos por occurred_at no app
  // (a spec §5.3 exige ordem cronológica do mundo para minimizar supersede retroativo).
  const { rows } = await pool.query<ProcessingRow & { _occurred_at: Date }>(
    `WITH due AS (
       SELECT lp.id, e.occurred_at
         FROM lua_processing lp
         JOIN episodes e ON e.id = lp.episode_id
        WHERE lp.status IN ('pending', 'chunked', 'failed')
          AND lp.next_attempt_at <= NOW()
          AND (lp.claimed_at IS NULL OR lp.claimed_at < NOW() - INTERVAL '15 minutes')
          AND lp.episode_revision = e.revision
        ORDER BY e.occurred_at ASC
        LIMIT $2
        FOR UPDATE OF lp SKIP LOCKED
     )
     UPDATE lua_processing p
        SET claimed_at = NOW(), claimed_by = $1
       FROM due
      WHERE p.id = due.id
      RETURNING p.*, due.occurred_at AS _occurred_at`,
    [workerId, batch]
  );
  rows.sort((a, b) => a._occurred_at.getTime() - b._occurred_at.getTime());
  return rows.map(({ _occurred_at, ...row }) => row);
}

// ── 3. Marcar revisions obsoletas (spec §5.3) ──────────────────────────────

/**
 * Marca como `skipped` (`last_error='stale_revision'`) as linhas pending/failed/chunked
 * cuja episode_revision ficou pra trás da revision atual do episódio (re-import na fila).
 * Retorna quantidade marcada.
 */
export async function markStaleRevisions(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE lua_processing lp
        SET status = 'skipped', last_error = 'stale_revision'
       FROM episodes e
      WHERE e.id = lp.episode_id
        AND lp.status IN ('pending', 'failed', 'chunked')
        AND lp.episode_revision < e.revision`
  );
  return rowCount ?? 0;
}

// ── 4. Inserção idempotente de chunks (spec §5.3-A3) ───────────────────────

/**
 * Delete-insert idempotente dos chunks de um episódio (TX do caller).
 * Re-rodar produz a mesma contagem (sem duplicatas).
 */
export async function insertChunksTx(
  client: PoolClient,
  args: {
    episodeId: number;
    episodeRevision: number;
    workspaceId: string;
    chunks: ChunkInput[];
  }
): Promise<void> {
  await client.query(`DELETE FROM episode_chunks WHERE episode_id = $1`, [
    args.episodeId,
  ]);
  for (const c of args.chunks) {
    await client.query(
      `INSERT INTO episode_chunks
         (episode_id, episode_revision, workspace_id, chunk_index,
          turn_start, turn_end, char_start, char_end, text, token_count,
          embedding, embedding_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector, $12)`,
      [
        args.episodeId,
        args.episodeRevision,
        args.workspaceId,
        c.chunkIndex,
        c.turnStart,
        c.turnEnd,
        c.charStart,
        c.charEnd,
        c.text,
        c.tokenCount,
        toVectorLiteral(c.embedding),
        c.embeddingModel,
      ]
    );
  }
}

// ── 5. Conclusão de processamento com fencing de lease (spec §5.3) ─────────

/**
 * Conclui (ou re-marca) uma linha de processamento condicionada ao claim vigente
 * (fencing: id + claimed_by + claimed_at originais). Retorna true se afetou 1 linha,
 * false se o lease foi perdido (0 linhas) — o caller descarta o resultado em silêncio.
 */
export async function finishProcessingTx(
  client: PoolClient,
  args: {
    id: number;
    claimedBy: string;
    claimedAt: Date | string;
    status: ProcessingStatus;
    stats: Record<string, unknown>;
  }
): Promise<boolean> {
  // Fencing por claimed_at. pg timestamptz é µs e JS Date é ms; comparação direta
  // falha sempre (bug-trap conhecido — pg-timestamptz-ms-precision). date_trunc nos
  // dois lados garante a igualdade quando o lease é o mesmo que foi reivindicado.
  const { rowCount } = await client.query(
    `UPDATE lua_processing
        SET status = $4,
            stats = $5,
            processed_at = NOW(),
            claimed_at = NULL,
            last_error = NULL
      WHERE id = $1 AND claimed_by = $2
        AND date_trunc('milliseconds', claimed_at) = date_trunc('milliseconds', $3::timestamptz)`,
    [args.id, args.claimedBy, args.claimedAt, args.status, JSON.stringify(args.stats)]
  );
  return (rowCount ?? 0) > 0;
}

// ── 6. Falha com backoff / dead (spec §5.2/§7) ─────────────────────────────

/**
 * Incrementa attempt_count e agenda retry com backoff min(attempt×60s, 15min);
 * ao atingir LUA_MAX_ATTEMPTS marca `dead`. Libera o lease.
 */
export async function failProcessing(
  id: number,
  errorText: string
): Promise<{ dead: boolean }> {
  const { rows } = await pool.query<{ attempt_count: number }>(
    `UPDATE lua_processing
        SET attempt_count = attempt_count + 1
      WHERE id = $1
      RETURNING attempt_count`,
    [id]
  );
  const attempt = rows[0]?.attempt_count ?? 0;
  if (attempt >= LUA_MAX_ATTEMPTS) {
    await pool.query(
      `UPDATE lua_processing
          SET status = 'dead', last_error = $2, claimed_at = NULL
        WHERE id = $1`,
      [id, errorText]
    );
    return { dead: true };
  }
  const backoffSec = Math.min(attempt * 60, 15 * 60);
  await pool.query(
    `UPDATE lua_processing
        SET status = 'failed',
            last_error = $3,
            claimed_at = NULL,
            next_attempt_at = NOW() + ($2 || ' seconds')::INTERVAL
      WHERE id = $1`,
    [id, String(backoffSec), errorText]
  );
  return { dead: false };
}

// ── 7. Inserção de fato (spec §4.3 / migration 021) ────────────────────────

/** Insere um fato (todas as colunas da migration 021). Retorna o id novo. */
export async function insertFactTx(
  client: PoolClient,
  fact: FactInput
): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO facts
       (workspace_id, fact_type, statement, attributes, confidence,
        valid_at, invalid_at, superseded_by_fact_id, invalidation_reason,
        episode_id, episode_revision, turn_start, turn_end,
        needs_review, review_note,
        embedding, embedding_model, extracted_by, run_id)
     VALUES ($1, $2, $3, $4, $5,
             $6, $7, $8, $9,
             $10, $11, $12, $13,
             $14, $15,
             $16::vector, $17, $18, $19)
     RETURNING id`,
    [
      fact.workspaceId,
      fact.factType,
      fact.statement,
      JSON.stringify(fact.attributes ?? {}),
      fact.confidence,
      fact.validAt,
      fact.invalidAt ?? null,
      fact.supersededByFactId ?? null,
      fact.invalidationReason ?? null,
      fact.episodeId,
      fact.episodeRevision,
      fact.turnStart,
      fact.turnEnd,
      fact.needsReview ?? false,
      fact.reviewNote ?? null,
      toVectorLiteral(fact.embedding),
      fact.embeddingModel,
      fact.extractedBy,
      fact.runId ?? null,
    ]
  );
  return Number(rows[0]!.id);
}

// ── 8. Supersede de fato (spec §6.3) ───────────────────────────────────────

/**
 * Invalida um fato existente apontando-o para o sucessor.
 * O CHECK facts_invalidation_chk exige invalid_at e invalidation_reason juntos.
 */
export async function supersedeFactTx(
  client: PoolClient,
  args: { existingId: number; newId: number; invalidAt: Date | string; reason: string }
): Promise<void> {
  await client.query(
    `UPDATE facts
        SET invalid_at = $2,
            superseded_by_fact_id = $3,
            invalidation_reason = $4
      WHERE id = $1`,
    [args.existingId, args.invalidAt, args.newId, args.reason]
  );
}

// ── 9. Flag de fato para revisão (spec §6.5) ───────────────────────────────

/** Marca needs_review=TRUE e anexa a nota ao review_note existente. */
export async function flagFactTx(
  client: PoolClient,
  id: number,
  note: string
): Promise<void> {
  await client.query(
    `UPDATE facts
        SET needs_review = TRUE,
            review_note = CASE
              WHEN review_note IS NULL OR review_note = '' THEN $2
              ELSE review_note || E'\n' || $2
            END
      WHERE id = $1`,
    [id, note]
  );
}

// ── 10. Busca exata de vizinhos (spec §6.1, Codex #7) ──────────────────────

/**
 * Busca EXATA (HNSW desligado) dos vizinhos vigentes do mesmo workspace+tipo,
 * ordenados por distância cosseno, filtrados por similaridade >= minSim.
 * `SET LOCAL enable_indexscan = off` exige rodar dentro de uma transação.
 */
export async function searchNeighbors(
  client: PoolClient,
  args: {
    workspaceId: string;
    factType: string;
    embedding: number[];
    limit: number;
    minSim: number;
  }
): Promise<NeighborRow[]> {
  await client.query(`SET LOCAL enable_indexscan = off`);
  const vec = toVectorLiteral(args.embedding);
  const { rows } = await client.query<{ id: string; statement: string; valid_at: Date; similarity: number }>(
    `SELECT id, statement, valid_at, 1 - (embedding <=> $3::vector) AS similarity
       FROM facts
      WHERE workspace_id = $1
        AND fact_type = $2
        AND invalid_at IS NULL
      ORDER BY embedding <=> $3::vector
      LIMIT $4`,
    [args.workspaceId, args.factType, vec, args.limit]
  );
  return rows
    .map((r) => ({ id: Number(r.id), statement: r.statement, valid_at: r.valid_at, similarity: Number(r.similarity) }))
    .filter((r) => r.similarity >= args.minSim);
}

// ── 11. Ledger de runs (spec §4.2 / migration 020) ─────────────────────────

/**
 * Abre um run. Para `nightly`, o índice parcial idx_lua_runs_one_nightly garante
 * 1 run por data — ON CONFLICT DO NOTHING; retorna null se a noite já tem run.
 */
export async function startRun(
  kind: RunKind,
  runDate: Date | string
): Promise<number | null> {
  if (kind === 'nightly') {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO lua_runs (kind, run_date)
       VALUES ('nightly', $1)
       ON CONFLICT (run_date) WHERE kind = 'nightly'
       DO NOTHING
       RETURNING id`,
      [runDate]
    );
    return rows[0] ? Number(rows[0].id) : null;
  }
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO lua_runs (kind, run_date) VALUES ($1, $2) RETURNING id`,
    [kind, runDate]
  );
  return Number(rows[0]!.id);
}

/** Fecha um run com status final, stats e erro opcional. */
export async function finishRun(
  id: number,
  status: RunStatus,
  stats: Record<string, unknown>,
  error?: string | null
): Promise<void> {
  await pool.query(
    `UPDATE lua_runs
        SET status = $2, stats = $3, error = $4, finished_at = NOW()
      WHERE id = $1`,
    [id, status, JSON.stringify(stats), error ?? null]
  );
}
