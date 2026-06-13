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

export type FactType =
  | 'decisao'
  | 'preferencia'
  | 'restricao'
  | 'compromisso'
  | 'contexto'
  | 'objetivo'
  | 'ameaca'
  | 'oportunidade'
  | 'marco'
  | 'papel';

/** Linha de fato no formato de leitura (`get_fatos`, §8.3 / kind `fato` §8.2). */
export type FactRow = {
  id: number;
  schema_version: string;
  workspace_id: string;
  fact_type: string;
  statement: string;
  attributes: Record<string, unknown>;
  confidence: number;
  valid_at: string;
  invalid_at: string | null;
  superseded_by_fact_id: number | null;
  invalidation_reason: string | null;
  needs_review: boolean;
  review_note: string | null;
  episode_id: number;
  episode_revision: number;
  turn_start: number;
  turn_end: number;
  extracted_by: string;
  created_at: string;
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

// ── 12. Leitura de fatos — as-of bi-temporal + keyset cursor (spec §8.3) ────

/** Serializa a linha crua de `facts` no formato de leitura (§8.3). */
function mapFactRow(r: Record<string, unknown>): FactRow {
  return {
    id: Number(r.id),
    schema_version: r.schema_version as string,
    workspace_id: r.workspace_id as string,
    fact_type: r.fact_type as string,
    statement: r.statement as string,
    attributes: (r.attributes as Record<string, unknown>) ?? {},
    confidence: Number(r.confidence),
    valid_at: (r.valid_at as Date).toISOString(),
    invalid_at: r.invalid_at ? (r.invalid_at as Date).toISOString() : null,
    superseded_by_fact_id:
      r.superseded_by_fact_id != null ? Number(r.superseded_by_fact_id) : null,
    invalidation_reason: (r.invalidation_reason as string | null) ?? null,
    needs_review: r.needs_review as boolean,
    review_note: (r.review_note as string | null) ?? null,
    episode_id: Number(r.episode_id),
    episode_revision: Number(r.episode_revision),
    turn_start: Number(r.turn_start),
    turn_end: Number(r.turn_end),
    extracted_by: r.extracted_by as string,
    created_at: (r.created_at as Date).toISOString(),
  };
}

export type GetFatosFilters = {
  types?: FactType[];
  /** As-of bi-temporal (default: agora). */
  vigenteEm?: Date | string;
  /** Inclui fatos invalidos (ignora a janela as-of). Default false. */
  includeInvalid?: boolean;
  /** Filtro lexical (`websearch_to_tsquery`). */
  q?: string;
  episodeId?: number;
  limit?: number;
  cursor?: string;
};

const FATOS_DEFAULT_LIMIT = 50;
const FATOS_MAX_LIMIT = 200;

/**
 * Lista fatos de um workspace com janela as-of bi-temporal (§8.3):
 *   valid_at <= $t AND (invalid_at IS NULL OR invalid_at > $t)
 * `includeInvalid` desliga a janela (retorna histórico). Keyset cursor
 * `(valid_at DESC, id DESC)`, base64url — mesma codificação das rotas de
 * episódios (`occurred_at_iso|id`), aqui `valid_at_iso|id`. `needs_review` e
 * `superseded_by_fact_id` SEMPRE presentes no payload (o consumidor precisa
 * ver a suspeita e a cadeia).
 */
export async function getFatos(
  workspaceId: string,
  filters: GetFatosFilters
): Promise<{ fatos: FactRow[]; next_cursor: string | null }> {
  const limit = Math.min(filters.limit ?? FATOS_DEFAULT_LIMIT, FATOS_MAX_LIMIT);
  const where: string[] = ['workspace_id = $1'];
  const args: unknown[] = [workspaceId];
  const p = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };

  if (!filters.includeInvalid) {
    const t = filters.vigenteEm ?? new Date();
    const tp = p(t);
    where.push(`valid_at <= ${tp}::timestamptz`);
    where.push(`(invalid_at IS NULL OR invalid_at > ${tp}::timestamptz)`);
  }
  if (filters.types && filters.types.length) {
    where.push(`fact_type = ANY(${p(filters.types)})`);
  }
  if (filters.q) {
    where.push(`tsv @@ websearch_to_tsquery('portuguese', ${p(filters.q)})`);
  }
  if (filters.episodeId != null) {
    where.push(`episode_id = ${p(filters.episodeId)}`);
  }
  if (filters.cursor) {
    const decoded = Buffer.from(filters.cursor, 'base64url').toString();
    const pipeIdx = decoded.lastIndexOf('|');
    if (pipeIdx < 0) throw new Error('cursor inválido');
    const iso = decoded.slice(0, pipeIdx);
    const idPart = decoded.slice(pipeIdx + 1);
    if (Number.isNaN(Date.parse(iso))) throw new Error('cursor inválido');
    if (!/^\d+$/.test(idPart)) throw new Error('cursor inválido');
    where.push(`(valid_at, id) < (${p(new Date(iso))}, ${p(Number(idPart))})`);
  }

  const sql = `SELECT * FROM facts WHERE ${where.join(' AND ')}
               ORDER BY valid_at DESC, id DESC LIMIT ${p(limit + 1)}`;
  const { rows } = await pool.query(sql, args);
  const fatos = rows.slice(0, limit).map(mapFactRow);
  const last = fatos[fatos.length - 1];
  const next_cursor =
    rows.length > limit && last
      ? Buffer.from(`${last.valid_at}|${last.id}`).toString('base64url')
      : null;
  return { fatos, next_cursor };
}

// ── 13. Status vigente do projeto (spec §8.5) ──────────────────────────────

export type ProjectStatusView = {
  workspace_id: string;
  content_md: string;
  generated_at: string;
  sources: Array<{ fact_id: number; episode_id: number | null }>;
};

/**
 * Status descritivo vigente: a linha mais recente de `project_status` do
 * workspace + suas fontes (com o episode_id do fato citado, p/ proveniência).
 * null quando o workspace ainda não tem status (a Central mostra vazio honesto).
 */
export async function getStatusVigente(
  workspaceId: string
): Promise<ProjectStatusView | null> {
  const { rows } = await pool.query<{
    id: string;
    content_md: string;
    created_at: Date;
  }>(
    `SELECT id, content_md, created_at
       FROM project_status
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [workspaceId]
  );
  if (!rows[0]) return null;
  const statusId = Number(rows[0].id);
  const { rows: srcRows } = await pool.query<{
    fact_id: string;
    episode_id: string | null;
  }>(
    `SELECT pss.fact_id, f.episode_id
       FROM project_status_sources pss
       LEFT JOIN facts f ON f.id = pss.fact_id
      WHERE pss.status_id = $1
      ORDER BY pss.fact_id ASC`,
    [statusId]
  );
  return {
    workspace_id: workspaceId,
    content_md: rows[0].content_md,
    generated_at: rows[0].created_at.toISOString(),
    sources: srcRows.map((s) => ({
      fact_id: Number(s.fact_id),
      episode_id: s.episode_id != null ? Number(s.episode_id) : null,
    })),
  };
}

// ── 14. Admin: observabilidade, DLQ e triagem (spec §7) ────────────────────

export type RunRow = {
  id: number;
  kind: string;
  run_date: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  stats: Record<string, unknown>;
  error: string | null;
};

/** Últimos runs com stats (mais recentes primeiro). */
export async function listRuns(limit = 20): Promise<RunRow[]> {
  const lim = Math.min(Math.max(limit, 1), 200);
  const { rows } = await pool.query(
    `SELECT id, kind, run_date, started_at, finished_at, status, stats, error
       FROM lua_runs
      ORDER BY started_at DESC
      LIMIT $1`,
    [lim]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    run_date:
      r.run_date instanceof Date
        ? r.run_date.toISOString().slice(0, 10)
        : String(r.run_date),
    started_at: (r.started_at as Date).toISOString(),
    finished_at: r.finished_at ? (r.finished_at as Date).toISOString() : null,
    status: r.status,
    stats: r.stats ?? {},
    error: r.error ?? null,
  }));
}

/** Fila/DLQ de processamento, opcionalmente filtrada por status. */
export async function listProcessing(args: {
  status?: ProcessingStatus;
  limit?: number;
}): Promise<ProcessingRow[]> {
  const lim = Math.min(Math.max(args.limit ?? 100, 1), 500);
  const params: unknown[] = [];
  let whereSql = '';
  if (args.status) {
    params.push(args.status);
    whereSql = `WHERE status = $1`;
  }
  params.push(lim);
  const { rows } = await pool.query<ProcessingRow>(
    `SELECT * FROM lua_processing ${whereSql}
      ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

/**
 * Replay de DLQ (§7): `dead` → `pending`, zera attempt_count, libera lease,
 * agenda imediato e PRESERVA last_error (rastro do que matou a linha). Só age
 * sobre linhas `dead`. Retorna true se afetou.
 */
export async function replayDead(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE lua_processing
        SET status = 'pending', attempt_count = 0,
            claimed_at = NULL, claimed_by = NULL, next_attempt_at = NOW()
      WHERE id = $1 AND status = 'dead'`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Força reprocessamento de um episódio (§7, semântica de revision §4.6):
 * enfileira/reseta a linha de processing da revision ATUAL do episódio para
 * `pending` (attempt zerado, lease liberado, due agora). UPSERT por
 * (episode_id, episode_revision). Retorna false se o episódio não existe.
 */
export async function forceReprocess(episodeId: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO lua_processing (episode_id, episode_revision)
     SELECT e.id, e.revision FROM episodes e WHERE e.id = $1
     ON CONFLICT (episode_id, episode_revision) DO UPDATE
        SET status = 'pending', attempt_count = 0,
            claimed_at = NULL, claimed_by = NULL,
            last_error = NULL, next_attempt_at = NOW()`,
    [episodeId]
  );
  return (rowCount ?? 0) > 0;
}

/** Fatos flagados de um workspace para triagem (§7). */
export async function listReviewFacts(workspaceId: string): Promise<FactRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM facts
      WHERE workspace_id = $1 AND needs_review = TRUE
      ORDER BY created_at DESC, id DESC`,
    [workspaceId]
  );
  return rows.map(mapFactRow);
}

export type ResolveFactAction =
  | { action: 'confirm' }
  | { action: 'invalidate' }
  | { action: 'supersede_by'; targetId: number };

/**
 * Resolução manual de um fato flagado (§7, auditoria implícita):
 *  - confirm: limpa needs_review (o fato é legítimo).
 *  - invalidate: invalid_at=NOW(), reason='manual', limpa needs_review.
 *  - supersede_by: invalida apontando para o fato sucessor (reason='manual').
 * Retorna true se afetou a linha.
 */
export async function resolveFact(
  id: number,
  resolution: ResolveFactAction
): Promise<boolean> {
  if (resolution.action === 'confirm') {
    const { rowCount } = await pool.query(
      `UPDATE facts SET needs_review = FALSE WHERE id = $1`,
      [id]
    );
    return (rowCount ?? 0) > 0;
  }
  if (resolution.action === 'invalidate') {
    const { rowCount } = await pool.query(
      `UPDATE facts
          SET invalid_at = NOW(), invalidation_reason = 'manual',
              needs_review = FALSE
        WHERE id = $1`,
      [id]
    );
    return (rowCount ?? 0) > 0;
  }
  // supersede_by
  const { rowCount } = await pool.query(
    `UPDATE facts
        SET invalid_at = NOW(), invalidation_reason = 'manual',
            superseded_by_fact_id = $2, needs_review = FALSE
      WHERE id = $1`,
    [id, resolution.targetId]
  );
  return (rowCount ?? 0) > 0;
}

/** Apaga um recap (§14 #16: regenerar exige delete admin). */
export async function deleteRecap(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM recaps WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

// ── 15. Narradora: status do projeto + recap semanal (spec §10) ─────────────

/** Linha de fato como insumo da narradora (sem embedding/tsv). */
export type StatusFactRow = {
  id: number;
  fact_type: string;
  statement: string;
  attributes: Record<string, unknown>;
  valid_at: string;
};

/**
 * Fatos VIGENTES (invalid_at IS NULL) e NAO-flagados (needs_review=false) de um
 * workspace, priorizados por tipo para a sintese do status (spec §10.2):
 *   objetivo/decisao (parametros atuais) -> compromisso (due dates) ->
 *   ameaca/oportunidade -> marco (recente) -> papel.
 * Status NAO publica suspeita, entao `needs_review` fica de fora.
 * Empate de prioridade: valid_at DESC (mais recente primeiro).
 */
export async function getVigenteFactsForStatus(
  workspaceId: string
): Promise<StatusFactRow[]> {
  const { rows } = await pool.query(
    `SELECT id, fact_type, statement, attributes, valid_at
       FROM facts
      WHERE workspace_id = $1
        AND invalid_at IS NULL
        AND needs_review = FALSE
      ORDER BY
        CASE fact_type
          WHEN 'objetivo'     THEN 1
          WHEN 'decisao'      THEN 1
          WHEN 'compromisso'  THEN 2
          WHEN 'ameaca'       THEN 3
          WHEN 'oportunidade' THEN 3
          WHEN 'marco'        THEN 4
          WHEN 'papel'        THEN 5
          ELSE 6
        END ASC,
        valid_at DESC, id DESC`,
    [workspaceId]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    fact_type: r.fact_type as string,
    statement: r.statement as string,
    attributes: (r.attributes as Record<string, unknown>) ?? {},
    valid_at: (r.valid_at as Date).toISOString(),
  }));
}

/**
 * Append-only de um status de projeto (spec §10.2 / §4.4). Insere a linha de
 * `project_status` + as fontes (`project_status_sources`, fatos usados) numa TX.
 * Retorna o id novo.
 */
export async function insertProjectStatus(args: {
  workspaceId: string;
  contentMd: string;
  model: string;
  runId?: number | null;
  factIds: number[];
}): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO project_status (workspace_id, content_md, model, run_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [args.workspaceId, args.contentMd, args.model, args.runId ?? null]
    );
    const statusId = Number(rows[0]!.id);
    for (const factId of args.factIds) {
      await client.query(
        `INSERT INTO project_status_sources (status_id, fact_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [statusId, factId]
      );
    }
    await client.query('COMMIT');
    return statusId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Recap persistido (formato de leitura get_recap, §8.4). */
export type RecapRow = {
  id: number;
  workspace_id: string;
  period_start: string;
  period_end: string;
  content_md: string;
  sources: number[];
};

function mapRecapRow(
  r: { id: string; workspace_id: string; period_start: Date | string; period_end: Date | string; content_md: string },
  sources: number[]
): RecapRow {
  const toDate = (v: Date | string) =>
    v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  return {
    id: Number(r.id),
    workspace_id: r.workspace_id,
    period_start: toDate(r.period_start),
    period_end: toDate(r.period_end),
    content_md: r.content_md,
    sources,
  };
}

/** Recap de uma semana (workspace + period_start). null se nao existir. */
export async function getRecapByWeek(
  workspaceId: string,
  periodStart: string
): Promise<RecapRow | null> {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, period_start, period_end, content_md
       FROM recaps
      WHERE workspace_id = $1 AND period_start = $2::date`,
    [workspaceId, periodStart]
  );
  if (!rows[0]) return null;
  const id = Number(rows[0].id);
  const { rows: src } = await pool.query<{ episode_id: string }>(
    `SELECT episode_id FROM recap_sources WHERE recap_id = $1 ORDER BY episode_id`,
    [id]
  );
  return mapRecapRow(rows[0] as never, src.map((s) => Number(s.episode_id)));
}

/**
 * Insere um recap idempotente por semana (spec §10.1 / UNIQUE workspace+period_start):
 * ON CONFLICT DO NOTHING. Retorna o id (novo OU o existente, sem reescrever o
 * conteudo). `created` indica se a linha foi de fato inserida agora — o caller
 * usa isso para NAO regravar fontes de um recap pre-existente.
 */
export async function insertRecap(args: {
  workspaceId: string;
  periodStart: string;
  periodEnd: string;
  contentMd: string;
  model: string;
  runId?: number | null;
  episodeIds: number[];
}): Promise<{ id: number; created: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query<{ id: string }>(
      `INSERT INTO recaps (workspace_id, period_start, period_end, content_md, model, run_id)
       VALUES ($1, $2::date, $3::date, $4, $5, $6)
       ON CONFLICT (workspace_id, period_start) DO NOTHING
       RETURNING id`,
      [args.workspaceId, args.periodStart, args.periodEnd, args.contentMd, args.model, args.runId ?? null]
    );
    if (!ins.rows[0]) {
      // Ja existia: busca o id existente, NAO toca em conteudo/fontes.
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM recaps WHERE workspace_id = $1 AND period_start = $2::date`,
        [args.workspaceId, args.periodStart]
      );
      await client.query('COMMIT');
      return { id: Number(rows[0]!.id), created: false };
    }
    const recapId = Number(ins.rows[0].id);
    for (const episodeId of args.episodeIds) {
      await client.query(
        `INSERT INTO recap_sources (recap_id, episode_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [recapId, episodeId]
      );
    }
    await client.query('COMMIT');
    return { id: recapId, created: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export type WeekActivity = {
  episodes: { id: number; title: string | null; occurred_at: string }[];
  factsChanged: number; // fatos criados OU invalidados na janela
};

/**
 * Atividade de um workspace numa janela [start, end] (spec §10.1):
 *  - episodios cujo occurred_at cai na janela (insumo + gate de atividade);
 *  - contagem de fatos novos (valid_at na janela) OU invalidados (invalid_at na
 *    janela) — o segundo braco do gate (atividade pode existir sem episodio novo).
 * A janela e inclusiva nas duas pontas (datas locais; ::date no boundary).
 */
export async function getWeekActivity(
  workspaceId: string,
  start: string,
  end: string
): Promise<WeekActivity> {
  const { rows: eps } = await pool.query(
    `SELECT id, title, occurred_at
       FROM episodes
      WHERE workspace_id = $1
        AND occurred_at >= $2::date
        AND occurred_at < ($3::date + INTERVAL '1 day')
      ORDER BY occurred_at ASC, id ASC`,
    [workspaceId, start, end]
  );
  const { rows: fc } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM facts
      WHERE workspace_id = $1
        AND (
          (valid_at >= $2::date AND valid_at < ($3::date + INTERVAL '1 day'))
          OR (invalid_at >= $2::date AND invalid_at < ($3::date + INTERVAL '1 day'))
        )`,
    [workspaceId, start, end]
  );
  return {
    episodes: eps.map((e) => ({
      id: Number(e.id),
      title: (e.title as string | null) ?? null,
      occurred_at: (e.occurred_at as Date).toISOString(),
    })),
    factsChanged: Number(fc[0]!.n),
  };
}

/** Fatos novos/supersedidos na janela (insumo de tom do recap, §10.1). */
export async function getWeekFacts(
  workspaceId: string,
  start: string,
  end: string
): Promise<{ statement: string; fact_type: string; status: 'novo' | 'invalidado' }[]> {
  const { rows } = await pool.query(
    `SELECT statement, fact_type,
            CASE WHEN invalid_at IS NOT NULL
                 AND invalid_at >= $2::date
                 AND invalid_at < ($3::date + INTERVAL '1 day')
                 THEN 'invalidado' ELSE 'novo' END AS status
       FROM facts
      WHERE workspace_id = $1
        AND (
          (valid_at >= $2::date AND valid_at < ($3::date + INTERVAL '1 day'))
          OR (invalid_at >= $2::date AND invalid_at < ($3::date + INTERVAL '1 day'))
        )
      ORDER BY valid_at ASC, id ASC`,
    [workspaceId, start, end]
  );
  return rows.map((r) => ({
    statement: r.statement as string,
    fact_type: r.fact_type as string,
    status: r.status as 'novo' | 'invalidado',
  }));
}
