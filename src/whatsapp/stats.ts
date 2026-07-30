/**
 * src/whatsapp/stats.ts
 *
 * Aggregate stats for /whatsapp/stats (T12 — Fase 4 §4.2).
 *
 * Returns counts WITHOUT paginating all threads, resolving the "29 × 741"
 * anti-pattern of calling list_threads in a loop just to count things.
 *
 * Notes on scoping:
 *   - All queries are parameterized: $1=workspaceId, $2=numberId (or NULL),
 *     $3=since (or NULL), $4=until (or NULL), $5=periodBasis.
 *   - `byIngestSource` counts MESSAGES (not threads); documented in the return type.
 *     Under a period window it counts messages whose created_at is in the window,
 *     so it may diverge from the per-thread buckets — this is a granularity
 *     difference, not incoherence (spec §6.2).
 *   - `byStage`, `byTemperature`, `bySource` include a `null` bucket for threads
 *     with no value set (IS NULL in DB or no thread_meta row). The key is the
 *     literal string "null" in the record.
 *   - `byTag` counts threads per tag (a thread with 2 tags contributes 1 to each).
 */

import type { Pool } from 'pg';
// Escopo de workspace ($1) — autoridade única em sql-scope.ts.
import { WORKSPACE_NUMBERS } from './sql-scope.js';

export type Stats = {
  /** Total distinct thread identifiers in scope. */
  total: number;
  /**
   * Tri-state de triagem por thread (mesma semântica de lead-filter.ts, spec v3 §2/§10):
   *   - `lead`       = is_lead = TRUE APENAS
   *   - `not_lead`   = is_lead = FALSE
   *   - `indefinido` = is_lead IS NULL (não triado) OU sem row de thread_meta
   * MUDANÇA v3: is_lead NULL NÃO conta mais como lead — virou o bucket `indefinido`.
   */
  byLeadStatus: { lead: number; not_lead: number; indefinido: number };
  /**
   * Threads per lead_stage value.
   * Key "null" = no stage set (IS NULL in DB).
   * Threads with no thread_meta row are counted under "null" as well.
   */
  byStage: Record<string, number>;
  /**
   * Threads per lead_temperature value (e.g. "quente", "morno", "frio").
   * Key "null" = no temperature set (IS NULL in DB or no thread_meta row).
   */
  byTemperature: Record<string, number>;
  /**
   * Threads per lead_source value.
   * Key "null" = no source set (IS NULL in DB or no thread_meta row).
   */
  bySource: Record<string, number>;
  /** DM vs group thread counts. */
  byKind: { dm: number; group: number };
  /**
   * MESSAGE count (not thread count) per ingest_source.
   * Typical values: "live", "backfill". Absent values are not returned.
   *
   * NOTE: Under a period window (since/until), this bucket counts messages
   * whose created_at falls in the window — it is message-level, not thread-level.
   * This means it can diverge from per-thread buckets (total/byKind/byLeadStatus/
   * byStage/byTemperature/bySource) when some messages in a qualifying thread fall
   * outside the window. This is intentional granularity, not incoherence (spec §6.2).
   */
  byIngestSource: Record<string, number>;
  /** Thread count per tag. Threads with no tags are not included. */
  byTag: Record<string, number>;
  /**
   * Opportunity entity counts by status (created_at in the requested window).
   * EXCLUI opps com loss_reason='nao_lead' (fora de relatórios, spec §5/§10).
   */
  byOpportunityStatus: Record<string, number>;
  /**
   * Opportunity entity counts by qualification (created_at in the requested window).
   * CHAVES STRING derivadas de is_qualified (fonte v3): NULL→'indefinido',
   * TRUE→'qualificado', FALSE→'desqualificado' (zero quebra nos charts). EXCLUI nao_lead.
   */
  byQualification: Record<string, number>;
  /** Distinct opportunity count per CRM tag. EXCLUI opps com loss_reason='nao_lead'. */
  byOpportunityTag: Record<string, number>;
  /**
   * Opportunity entity counts por motivo de PERDA (status='perdido'), na janela por
   * created_at (spec §10). Chave "null" = perda sem motivo registrado. EXCLUI o motivo
   * de sistema 'nao_lead' (perda de cascata não-lead, fora de relatórios — spec §5/§10).
   */
  byLossReason: Record<string, number>;
  /**
   * Métricas de TRIAGEM (aditivo — itens 4/5).
   * `queue`: REDEFINIDA na v3 (spec §5/§10) = tamanho da coluna `novas_conversas` do board
   *   = opps `em_andamento` de threads DM cujo is_lead IS NULL (ainda não triadas). Contada
   *   direto em whatsapp_opportunities (grupos nunca têm opp por invariante), independe de
   *   `kind` e da janela de período (é um snapshot vivo do board).
   * `hiddenGroups`: threads de grupo em números com expose_groups_in_mcp=FALSE — não
   *   qualificáveis, ficam FORA da fila; contadas aqui para transparência (elas inflam
   *   byStage.null e byKind.group).
   * `note`: aviso de que byStage.null/byLeadStatus incluem grupos e não-leads e não
   *   representam o tamanho da fila.
   */
  triage: { queue: number; hiddenGroups: number; note: string };
};

/**
 * Compute aggregate stats for a workspace (optionally scoped to one number
 * and/or a time window).
 *
 * @param pool  - Postgres connection pool.
 * @param p     - Query scope.
 *   - `numberId`: optional; omit to aggregate across all numbers.
 *   - `since` / `until`: optional ISO timestamps (inclusive bounds). Null/omitted
 *     means open bound (no window → all threads).
 *   - `periodBasis`: 'arrival' (default) — thread qualifies if its first message
 *     is in the window; 'activity' — thread qualifies if ANY message is in window.
 */
export async function getStats(
  pool: Pool,
  p: {
    workspaceId: string;
    numberId?: number;
    since?: string;
    until?: string;
    periodBasis?: 'arrival' | 'activity';
    kind?: 'dm' | 'group' | 'all';
  },
): Promise<Stats> {
  const periodBasis = p.periodBasis ?? 'arrival';
  const kind = p.kind ?? 'all';

  // $1=workspaceId, $2=numberId|null, $3=since|null, $4=until|null, $5=periodBasis, $6=kind
  const params: unknown[] = [
    p.workspaceId,
    p.numberId ?? null,
    p.since ?? null,
    p.until ?? null,
    periodBasis,
    kind,
  ];

  // The number-filter clause reused across all per-thread queries.
  // When $2 IS NULL it becomes a no-op (workspace alone is the scope).
  const numFilter = `AND ($2::int IS NULL OR m.whatsapp_number_id = $2)`;

  // ── Shared period CTE ────────────────────────────────────────────────────────
  // Materialises the set of thread identifiers that fall within [since, until]
  // according to periodBasis.
  //
  // arrival:  thread qualifies if MIN(m.created_at) ∈ [since, until].
  // activity: thread qualifies if ANY m.created_at ∈ [since, until].
  //
  // Open bounds (since=null / until=null) are handled naturally by the CASE
  // expressions — when $3 IS NULL the lower bound is always satisfied, and
  // likewise for $4. No special-case branch needed for "no window".
  //
  // All per-thread queries (total/byKind/byLeadStatus/byStage/byTemperature/
  // bySource/byTag) restrict their inner scans to this set, ensuring all
  // buckets are homogeneous under a period window.
  const periodCte = `
  threads_in_period AS (
    SELECT m.identifier
      FROM messages m
     WHERE m.workspace_id = $1 ${numFilter}
     GROUP BY m.identifier
    HAVING CASE WHEN $5 = 'activity'
                THEN bool_or(($3::timestamptz IS NULL OR m.created_at >= $3)
                         AND ($4::timestamptz IS NULL OR m.created_at <= $4))
                ELSE (($3::timestamptz IS NULL OR MIN(m.created_at) >= $3)
                  AND ($4::timestamptz IS NULL OR MIN(m.created_at) <= $4))
           END
  )`;

  // threads_scoped = threads_in_period filtrado por `kind` ($6). Deriva is_group por
  // thread (has_author via bool_or + EXISTS em whatsapp_groups) e aplica o predicado kind.
  // Usado pelos buckets thread-level (stage/temperature/source/tag). NÃO usado pela
  // mainQuery (que precisa do escopo TOTAL para byKind) nem pela ingestQuery (imune).
  const scopedCte = `${periodCte},
  threads_scoped AS (
    SELECT a.identifier
      FROM (
        SELECT m.identifier, bool_or(m.author IS NOT NULL) AS has_author
          FROM messages m
         WHERE m.workspace_id = $1 ${numFilter}
           AND m.identifier IN (SELECT identifier FROM threads_in_period)
         GROUP BY m.identifier
      ) a
      LEFT JOIN LATERAL (
        SELECT g2.jid FROM whatsapp_groups g2
         WHERE g2.jid = a.identifier
           AND g2.whatsapp_number_id IN ${WORKSPACE_NUMBERS}
           AND ($2::int IS NULL OR g2.whatsapp_number_id = $2)
         LIMIT 1
      ) g ON TRUE
     WHERE ($6 = 'all'
         OR ($6 = 'dm' AND NOT (a.has_author OR g.jid IS NOT NULL))
         OR ($6 = 'group' AND (a.has_author OR g.jid IS NOT NULL)))
  )`;

  // The 6 aggregate queries below are independent (no data dependency) and share
  // the same immutable params, so we fire them in parallel.

  // ── (1) total + byKind + byLeadStatus ────────────────────────────────────────
  // Single CTE pass: per-thread aggregation → classify kind / lead.
  // A thread is a "group" if any message has author IS NOT NULL OR a whatsapp_groups row exists.
  //
  // byLeadStatus semantics MUST stay in sync with `leadFilterSql` in lead-filter.ts
  // (MINOR #5): TRI-STATE v3 — lead = is_lead = TRUE APENAS; not_lead = is_lead = FALSE;
  //             indefinido = is_lead IS NULL (inclui thread sem meta row). A change to
  //             one MUST update the other. (triage.queue saiu daqui na v3 — é uma query
  //             própria em whatsapp_opportunities, ver triageQueueQuery abaixo.)
  //
  // Empty workspace → the inner subquery returns 0 rows → COUNT(*) = 0 but bare
  // SUM(...) would be NULL; COALESCE(...,0) keeps every field a number (IMPORTANT #1).
  const mainQuery = pool.query(
    `WITH ${periodCte}
     SELECT
       COUNT(*) FILTER (WHERE kind_match)::int AS total,
       COALESCE(SUM(CASE WHEN is_group THEN 1 ELSE 0 END), 0)::int AS group_count,
       COALESCE(SUM(CASE WHEN NOT is_group THEN 1 ELSE 0 END), 0)::int AS dm_count,
       COUNT(*) FILTER (WHERE kind_match AND tm_is_lead = TRUE)::int AS lead_count,
       COUNT(*) FILTER (WHERE kind_match AND tm_is_lead = FALSE)::int AS not_lead_count,
       COUNT(*) FILTER (WHERE kind_match AND tm_is_lead IS NULL)::int AS indefinido_count
     FROM (
       SELECT
         a.identifier,
         (a.has_author OR g.jid IS NOT NULL) AS is_group,
         ($6 = 'all'
           OR ($6 = 'dm' AND NOT (a.has_author OR g.jid IS NOT NULL))
           OR ($6 = 'group' AND (a.has_author OR g.jid IS NOT NULL))) AS kind_match,
         tm.is_lead                           AS tm_is_lead
         FROM (
           SELECT m.identifier,
                  bool_or(m.author IS NOT NULL) AS has_author
             FROM messages m
            WHERE m.workspace_id = $1 ${numFilter}
              AND m.identifier IN (SELECT identifier FROM threads_in_period)
            GROUP BY m.identifier
         ) a
         LEFT JOIN LATERAL (
           SELECT g2.jid
             FROM whatsapp_groups g2
            WHERE g2.jid = a.identifier
              AND g2.whatsapp_number_id IN ${WORKSPACE_NUMBERS}
              AND ($2::int IS NULL OR g2.whatsapp_number_id = $2)
            LIMIT 1
         ) g ON TRUE
         LEFT JOIN LATERAL (
           SELECT tm2.is_lead
             FROM whatsapp_thread_meta tm2
            WHERE tm2.identifier = a.identifier
              AND tm2.whatsapp_number_id IN ${WORKSPACE_NUMBERS}
              AND ($2::int IS NULL OR tm2.whatsapp_number_id = $2)
            ORDER BY tm2.whatsapp_number_id
            LIMIT 1
         ) tm ON TRUE
     ) sub`,
    params,
  );

  // ── (1b) triage.queue — coluna `novas_conversas` do board (spec §5/§10) ───────
  // REDEFINIDA na v3: opps `em_andamento` de threads DM cujo is_lead IS NULL (não
  // triadas). Query PRÓPRIA em whatsapp_opportunities — NÃO reusa threads_in_period/
  // threads_scoped (colapsam identifier entre números). Grupos nunca têm opp por
  // invariante, então não é preciso filtrar kind. Snapshot vivo do board: NÃO aplica
  // a janela de período (usa só $1/$2). O LATERAL sobre thread_meta é um lookup pela
  // PK (whatsapp_number_id, identifier) — is_lead IS NULL cobre "sem row" (LEFT JOIN
  // devolve NULL) e is_lead explicitamente NULL.
  const triageQueueQuery = pool.query(
    `SELECT COUNT(*)::int AS triage_queue
       FROM whatsapp_opportunities o
       LEFT JOIN LATERAL (
         SELECT tm.is_lead
           FROM whatsapp_thread_meta tm
          WHERE tm.whatsapp_number_id = o.whatsapp_number_id
            AND tm.identifier = o.identifier
          LIMIT 1
       ) tm ON TRUE
      WHERE o.workspace_id = $1
        AND ($2::int IS NULL OR o.whatsapp_number_id = $2)
        AND o.status = 'em_andamento'
        AND tm.is_lead IS NULL`,
    params.slice(0, 2),
  );

  // ── (2) byStage — per thread ──────────────────────────────────────────────
  // Threads without a thread_meta row → stage = NULL (bucketed as "null").
  const stageQuery = pool.query(
    `WITH ${scopedCte}
     SELECT COALESCE(tm.lead_stage, 'null') AS stage, COUNT(*)::int AS cnt
       FROM (
         SELECT DISTINCT m.identifier
           FROM messages m
          WHERE m.workspace_id = $1 ${numFilter}
            AND m.identifier IN (SELECT identifier FROM threads_scoped)
       ) t
       LEFT JOIN LATERAL (
         SELECT tm2.lead_stage
           FROM whatsapp_thread_meta tm2
          WHERE tm2.identifier = t.identifier
            AND tm2.whatsapp_number_id IN ${WORKSPACE_NUMBERS}
            AND ($2::int IS NULL OR tm2.whatsapp_number_id = $2)
          ORDER BY tm2.whatsapp_number_id
          LIMIT 1
       ) tm ON TRUE
      GROUP BY COALESCE(tm.lead_stage, 'null')`,
    params,
  );

  // ── (3) byTemperature — per thread ───────────────────────────────────────
  // Mirrors byStage, using lead_temperature instead. Key "null" = no temperature set.
  const temperatureQuery = pool.query(
    `WITH ${scopedCte}
     SELECT COALESCE(tm.lead_temperature, 'null') AS temperature, COUNT(*)::int AS cnt
       FROM (
         SELECT DISTINCT m.identifier
           FROM messages m
          WHERE m.workspace_id = $1 ${numFilter}
            AND m.identifier IN (SELECT identifier FROM threads_scoped)
       ) t
       LEFT JOIN LATERAL (
         SELECT tm2.lead_temperature
           FROM whatsapp_thread_meta tm2
          WHERE tm2.identifier = t.identifier
            AND tm2.whatsapp_number_id IN ${WORKSPACE_NUMBERS}
            AND ($2::int IS NULL OR tm2.whatsapp_number_id = $2)
          ORDER BY tm2.whatsapp_number_id
          LIMIT 1
       ) tm ON TRUE
      GROUP BY COALESCE(tm.lead_temperature, 'null')`,
    params,
  );

  // ── (4) bySource — per thread ────────────────────────────────────────────
  // Mirrors byStage, using lead_source instead. Key "null" = no source set.
  const sourceQuery = pool.query(
    `WITH ${scopedCte}
     SELECT COALESCE(tm.lead_source, 'null') AS source, COUNT(*)::int AS cnt
       FROM (
         SELECT DISTINCT m.identifier
           FROM messages m
          WHERE m.workspace_id = $1 ${numFilter}
            AND m.identifier IN (SELECT identifier FROM threads_scoped)
       ) t
       LEFT JOIN LATERAL (
         SELECT tm2.lead_source
           FROM whatsapp_thread_meta tm2
          WHERE tm2.identifier = t.identifier
            AND tm2.whatsapp_number_id IN ${WORKSPACE_NUMBERS}
            AND ($2::int IS NULL OR tm2.whatsapp_number_id = $2)
          ORDER BY tm2.whatsapp_number_id
          LIMIT 1
       ) tm ON TRUE
      GROUP BY COALESCE(tm.lead_source, 'null')`,
    params,
  );

  // ── (5) byIngestSource — message-level count ──────────────────────────────
  // NOTE: this is a MESSAGE count (not thread count); callers should be aware
  // that a thread with 5 live messages and 1 backfill message contributes 5+1.
  //
  // Under a period window this counts messages whose created_at ∈ [since, until]
  // directly — NOT via threads_in_period. This is intentional: byIngestSource
  // stays message-level granularity and may diverge from per-thread counts (spec §6.2).
  // NOTE: this query references only $1..$4 (it does NOT use $5/periodBasis — it's
  // message-level, not thread-level). Postgres rejects a bind that supplies MORE
  // params than the statement declares, so pass ONLY the 4 params it uses, not the
  // full `params` array shared by the per-thread queries.
  const ingestQuery = pool.query(
    `SELECT COALESCE(m.ingest_source, 'live') AS src, COUNT(*)::int AS cnt
       FROM messages m
      WHERE m.workspace_id = $1 ${numFilter}
        AND ($3::timestamptz IS NULL OR m.created_at >= $3)
        AND ($4::timestamptz IS NULL OR m.created_at <= $4)
      GROUP BY COALESCE(m.ingest_source, 'live')`,
    params.slice(0, 4),
  );

  // ── (6) byTag — thread count per tag ─────────────────────────────────────
  // Threads that have no tags are simply absent from this record.
  //
  // Scope tags DIRECTLY to the workspace's own numbers (IMPORTANT #2). Earlier we
  // matched tag rows via an identifier-EXISTS-in-messages trick; with $2 absent that
  // trick is workspace-blind on the tag side, so a tag attached to ANOTHER
  // workspace's number that happens to share an identifier (e.g. the same phone JID)
  // would leak into this workspace's byTag. Restricting tt.whatsapp_number_id to the
  // set of numbers owned by $1 (and to $2 when a single number is requested) makes a
  // cross-workspace leak impossible.
  //
  // Period- and kind-filtered for coherence: tags are restricted to threads in
  // threads_scoped so that byTag does not diverge from `total` under a window/kind.
  const tagQuery = pool.query(
    `WITH ${scopedCte}
     SELECT tt.tag, COUNT(DISTINCT tt.identifier)::int AS cnt
       FROM whatsapp_thread_tags tt
      WHERE tt.whatsapp_number_id IN ${WORKSPACE_NUMBERS}
        AND ($2::int IS NULL OR tt.whatsapp_number_id = $2)
        AND tt.identifier IN (SELECT identifier FROM threads_scoped)
      GROUP BY tt.tag`,
    params,
  );

  // ── (7) hiddenGroups — grupos em números com exposição OFF (transparência item 5) ──
  // Um thread é grupo se tem author OU existe whatsapp_groups.jid. "Oculto" = TODOS os
  // números do thread têm expose_groups_in_mcp=FALSE. Período-escopado (threads_in_period)
  // para coerência com total. Referencia $1..$5 (não usa $6/kind) → passa params.slice(0,5).
  const hiddenGroupsQuery = pool.query(
    `WITH ${periodCte}
     SELECT COUNT(*)::int AS hidden_groups
       FROM (
         SELECT m.identifier
           FROM messages m
           JOIN whatsapp_numbers n ON n.id = m.whatsapp_number_id
          WHERE m.workspace_id = $1 ${numFilter}
            AND m.identifier IN (SELECT identifier FROM threads_in_period)
          GROUP BY m.identifier
         HAVING bool_and(n.expose_groups_in_mcp = FALSE)
            AND (bool_or(m.author IS NOT NULL)
                 OR EXISTS (SELECT 1 FROM whatsapp_groups g
                             WHERE g.jid = m.identifier
                               AND g.whatsapp_number_id IN ${WORKSPACE_NUMBERS}
                               AND ($2::int IS NULL OR g.whatsapp_number_id = $2)))
       ) x`,
    params.slice(0, 5),
  );

  // Entity-level aggregates intentionally do NOT reuse threads_in_period /
  // threads_scoped: those CTEs collapse equal identifiers across numbers. Count
  // opportunity rows directly, scoped by their authoritative workspace/number
  // and their own created_at.
  //
  // EXCLUSÃO nao_lead (spec §5/§10): opps perdidas por cascata não-lead
  // (loss_reason='nao_lead') ficam FORA de todos os agregados de relatório. Filtramos
  // com `IS DISTINCT FROM 'nao_lead'` (loss_reason NULL passa — só existe em perdas).
  const opportunityStatusQuery = pool.query(
    `SELECT o.status AS key, COUNT(*)::int AS cnt
       FROM whatsapp_opportunities o
      WHERE o.workspace_id = $1
        AND ($2::int IS NULL OR o.whatsapp_number_id = $2)
        AND (o.loss_reason IS DISTINCT FROM 'nao_lead')
        AND ($3::timestamptz IS NULL OR o.created_at >= $3)
        AND ($4::timestamptz IS NULL OR o.created_at <= $4)
      GROUP BY o.status`,
    params.slice(0, 4),
  );
  // byQualification deriva de is_qualified (fonte v3), MAS mantém as chaves STRING
  // (indefinido/qualificado/desqualificado) — zero quebra nos charts da Fase 3.
  const qualificationQuery = pool.query(
    `SELECT CASE WHEN o.is_qualified IS NULL THEN 'indefinido'
                 WHEN o.is_qualified THEN 'qualificado'
                 ELSE 'desqualificado' END AS key,
            COUNT(*)::int AS cnt
       FROM whatsapp_opportunities o
      WHERE o.workspace_id = $1
        AND ($2::int IS NULL OR o.whatsapp_number_id = $2)
        AND (o.loss_reason IS DISTINCT FROM 'nao_lead')
        AND ($3::timestamptz IS NULL OR o.created_at >= $3)
        AND ($4::timestamptz IS NULL OR o.created_at <= $4)
      GROUP BY 1`,
    params.slice(0, 4),
  );
  const opportunityTagQuery = pool.query(
    `SELECT t.name AS key, COUNT(DISTINCT o.id)::int AS cnt
       FROM whatsapp_opportunities o
       JOIN whatsapp_opportunity_tags ot ON ot.opportunity_id = o.id
       JOIN whatsapp_tags t ON t.id = ot.tag_id AND t.workspace_id = $1
      WHERE o.workspace_id = $1
        AND ($2::int IS NULL OR o.whatsapp_number_id = $2)
        AND (o.loss_reason IS DISTINCT FROM 'nao_lead')
        AND ($3::timestamptz IS NULL OR o.created_at >= $3)
        AND ($4::timestamptz IS NULL OR o.created_at <= $4)
      GROUP BY t.id, t.name`,
    params.slice(0, 4),
  );
  // byLossReason (novo, spec §10): distribuição das PERDAS por motivo, na janela por
  // created_at. Chave "null" = perda sem motivo. Exclui o motivo de sistema 'nao_lead'
  // (perda de cascata, fora de relatórios) — pelo MESMO predicado dos demais agregados.
  const lossReasonQuery = pool.query(
    `SELECT COALESCE(o.loss_reason, 'null') AS key, COUNT(*)::int AS cnt
       FROM whatsapp_opportunities o
      WHERE o.workspace_id = $1
        AND ($2::int IS NULL OR o.whatsapp_number_id = $2)
        AND o.status = 'perdido'
        AND (o.loss_reason IS DISTINCT FROM 'nao_lead')
        AND ($3::timestamptz IS NULL OR o.created_at >= $3)
        AND ($4::timestamptz IS NULL OR o.created_at <= $4)
      GROUP BY 1`,
    params.slice(0, 4),
  );

  const [mainRes, stageRes, temperatureRes, sourceRes, ingestRes, tagRes, hiddenRes, triageRes, opportunityStatusRes, qualificationRes, opportunityTagRes, lossReasonRes] = await Promise.all([
    mainQuery,
    stageQuery,
    temperatureQuery,
    sourceQuery,
    ingestQuery,
    tagQuery,
    hiddenGroupsQuery,
    triageQueueQuery,
    opportunityStatusQuery,
    qualificationQuery,
    opportunityTagQuery,
    lossReasonQuery,
  ]);

  // Empty workspace → mainRes still returns exactly one row of zeros (COALESCE above),
  // but guard the no-row case defensively so every field stays a number.
  const mainRow = mainRes.rows[0] ?? { total: 0, group_count: 0, dm_count: 0, lead_count: 0, not_lead_count: 0, indefinido_count: 0 };

  const byStage: Record<string, number> = {};
  for (const r of stageRes.rows) {
    byStage[r.stage as string] = Number(r.cnt);
  }

  const byTemperature: Record<string, number> = {};
  for (const r of temperatureRes.rows) {
    byTemperature[r.temperature as string] = Number(r.cnt);
  }

  const bySource: Record<string, number> = {};
  for (const r of sourceRes.rows) {
    bySource[r.source as string] = Number(r.cnt);
  }

  const byIngestSource: Record<string, number> = {};
  for (const r of ingestRes.rows) {
    byIngestSource[r.src as string] = Number(r.cnt);
  }

  const byTag: Record<string, number> = {};
  for (const r of tagRes.rows) {
    byTag[r.tag as string] = Number(r.cnt);
  }
  const toRecord = (rows: any[]): Record<string, number> => Object.fromEntries(
    rows.map(r => [String(r.key), Number(r.cnt)]),
  );

  return {
    total: Number(mainRow.total) || 0,
    byLeadStatus: {
      lead: Number(mainRow.lead_count) || 0,
      not_lead: Number(mainRow.not_lead_count) || 0,
      indefinido: Number(mainRow.indefinido_count) || 0,
    },
    byStage,
    byTemperature,
    bySource,
    byKind: {
      dm: Number(mainRow.dm_count) || 0,
      group: Number(mainRow.group_count) || 0,
    },
    byIngestSource,
    byTag,
    byOpportunityStatus: toRecord(opportunityStatusRes.rows),
    byQualification: toRecord(qualificationRes.rows),
    byOpportunityTag: toRecord(opportunityTagRes.rows),
    byLossReason: toRecord(lossReasonRes.rows),
    triage: {
      queue: Number(triageRes.rows[0]?.triage_queue) || 0,
      hiddenGroups: Number(hiddenRes.rows[0]?.hidden_groups) || 0,
      note: "triage.queue = coluna 'novas_conversas' do board = opps em_andamento de DMs ainda não triadas (is_lead indefinido); snapshot vivo, ignora o período. byStage.null e byKind.group incluem grupos e não-leads — não use como tamanho de fila. hiddenGroups = grupos de números com exposição desligada (não qualificáveis, fora da fila).",
    },
  };
}
