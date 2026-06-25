/**
 * src/whatsapp/stats.ts
 *
 * Aggregate stats for /whatsapp/stats (T12 — Fase 4 §4.2).
 *
 * Returns counts WITHOUT paginating all threads, resolving the "29 × 741"
 * anti-pattern of calling list_threads in a loop just to count things.
 *
 * Notes on scoping:
 *   - All queries are parameterized: $1=workspaceId, $2=numberId (or NULL).
 *   - `byIngestSource` counts MESSAGES (not threads); documented in the return type.
 *   - `byStage` includes a `null` bucket for threads whose `lead_stage IS NULL`
 *     (= not yet qualified). The key is the literal string "null" in the record.
 *   - `byTag` counts threads per tag (a thread with 2 tags contributes 1 to each).
 */

import type { Pool } from 'pg';

export type Stats = {
  /** Total distinct thread identifiers in scope. */
  total: number;
  /** Lead vs not-lead thread counts (same semantics as lead-filter.ts). */
  byLeadStatus: { lead: number; not_lead: number };
  /**
   * Threads per lead_stage value.
   * Key "null" = no stage set (IS NULL in DB).
   * Threads with no thread_meta row are counted under "null" as well.
   */
  byStage: Record<string, number>;
  /** DM vs group thread counts. */
  byKind: { dm: number; group: number };
  /**
   * MESSAGE count (not thread count) per ingest_source.
   * Typical values: "live", "backfill". Absent values are not returned.
   */
  byIngestSource: Record<string, number>;
  /** Thread count per tag. Threads with no tags are not included. */
  byTag: Record<string, number>;
};

/**
 * Compute aggregate stats for a workspace (optionally scoped to one number).
 *
 * @param pool  - Postgres connection pool.
 * @param p     - Query scope. `numberId` is optional; omit to aggregate across all numbers.
 */
export async function getStats(
  pool: Pool,
  p: { workspaceId: string; numberId?: number },
): Promise<Stats> {
  // $1 = workspaceId, $2 = numberId | null (NULL means "all numbers in workspace")
  const params: unknown[] = [p.workspaceId, p.numberId ?? null];

  // The number-filter clause reused across all queries.
  // When $2 IS NULL it becomes a no-op (workspace alone is the scope).
  const numFilter = `AND ($2::int IS NULL OR m.whatsapp_number_id = $2)`;

  // ── (1) total + byKind + byLeadStatus + byStage ──────────────────────────
  // Single CTE pass: per-thread aggregation → classify kind / lead / stage.
  // A thread is a "group" if any message has author IS NOT NULL OR a whatsapp_groups row exists.
  const mainRes = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       SUM(CASE WHEN is_group THEN 1 ELSE 0 END)::int AS group_count,
       SUM(CASE WHEN NOT is_group THEN 1 ELSE 0 END)::int AS dm_count,
       SUM(CASE WHEN (tm_is_lead IS NULL OR tm_is_lead = TRUE) THEN 1 ELSE 0 END)::int AS lead_count,
       SUM(CASE WHEN tm_is_lead = FALSE THEN 1 ELSE 0 END)::int AS not_lead_count
     FROM (
       SELECT
         a.identifier,
         (a.has_author OR g.jid IS NOT NULL) AS is_group,
         tm.is_lead                           AS tm_is_lead
         FROM (
           SELECT m.identifier,
                  bool_or(m.author IS NOT NULL) AS has_author
             FROM messages m
            WHERE m.workspace_id = $1 ${numFilter}
            GROUP BY m.identifier
         ) a
         LEFT JOIN LATERAL (
           SELECT g2.jid
             FROM whatsapp_groups g2
            WHERE g2.jid = a.identifier
              AND ($2::int IS NULL OR g2.whatsapp_number_id = $2)
            LIMIT 1
         ) g ON TRUE
         LEFT JOIN LATERAL (
           SELECT tm2.is_lead, tm2.lead_stage
             FROM whatsapp_thread_meta tm2
            WHERE tm2.identifier = a.identifier
              AND ($2::int IS NULL OR tm2.whatsapp_number_id = $2)
            LIMIT 1
         ) tm ON TRUE
     ) sub`,
    params,
  );

  const mainRow = mainRes.rows[0] ?? { total: 0, group_count: 0, dm_count: 0, lead_count: 0, not_lead_count: 0 };

  // ── (2) byStage — per thread ──────────────────────────────────────────────
  // Threads without a thread_meta row → stage = NULL (bucketed as "null").
  const stageRes = await pool.query(
    `SELECT COALESCE(tm.lead_stage, 'null') AS stage, COUNT(*)::int AS cnt
       FROM (
         SELECT DISTINCT m.identifier
           FROM messages m
          WHERE m.workspace_id = $1 ${numFilter}
       ) t
       LEFT JOIN LATERAL (
         SELECT tm2.lead_stage
           FROM whatsapp_thread_meta tm2
          WHERE tm2.identifier = t.identifier
            AND ($2::int IS NULL OR tm2.whatsapp_number_id = $2)
          LIMIT 1
       ) tm ON TRUE
      GROUP BY COALESCE(tm.lead_stage, 'null')`,
    params,
  );

  const byStage: Record<string, number> = {};
  for (const r of stageRes.rows) {
    byStage[r.stage as string] = r.cnt as number;
  }

  // ── (3) byIngestSource — message-level count ──────────────────────────────
  // NOTE: this is a MESSAGE count (not thread count); callers should be aware
  // that a thread with 5 live messages and 1 backfill message contributes 5+1.
  const ingestRes = await pool.query(
    `SELECT COALESCE(m.ingest_source, 'live') AS src, COUNT(*)::int AS cnt
       FROM messages m
      WHERE m.workspace_id = $1 ${numFilter}
      GROUP BY COALESCE(m.ingest_source, 'live')`,
    params,
  );

  const byIngestSource: Record<string, number> = {};
  for (const r of ingestRes.rows) {
    byIngestSource[r.src as string] = r.cnt as number;
  }

  // ── (4) byTag — thread count per tag ─────────────────────────────────────
  // Threads that have no tags are simply absent from this record.
  // We scope tags to threads that exist in messages for this workspace/number.
  const tagRes = await pool.query(
    `SELECT tt.tag, COUNT(DISTINCT tt.identifier)::int AS cnt
       FROM whatsapp_thread_tags tt
      WHERE EXISTS (
        SELECT 1 FROM messages m
         WHERE m.workspace_id = $1
           ${numFilter}
           AND m.identifier = tt.identifier
      )
        AND ($2::int IS NULL OR tt.whatsapp_number_id = $2)
      GROUP BY tt.tag`,
    params,
  );

  const byTag: Record<string, number> = {};
  for (const r of tagRes.rows) {
    byTag[r.tag as string] = r.cnt as number;
  }

  return {
    total: mainRow.total as number,
    byLeadStatus: {
      lead: mainRow.lead_count as number,
      not_lead: mainRow.not_lead_count as number,
    },
    byStage,
    byKind: {
      dm: mainRow.dm_count as number,
      group: mainRow.group_count as number,
    },
    byIngestSource,
    byTag,
  };
}
