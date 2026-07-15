/**
 * src/whatsapp/timeseries.ts
 * Série temporal de conversas para /whatsapp/stats/timeseries.
 * arrival: thread ancora no bucket do MIN(created_at) (conversas NOVAS por bucket).
 * activity: thread conta em cada bucket onde teve mensagem (conversas ATIVAS).
 * Buckets em America/Sao_Paulo, zero-fill em JS. Sem identifier no payload.
 * leads segue a semântica de stats.ts: sem thread_meta OU is_lead=TRUE ⇒ lead.
 */
import type { Pool } from 'pg';

export type TimeseriesPoint = { bucketStart: string; total: number; leads: number };

const KIND_PREDICATE = `($6 = 'all'
  OR ($6 = 'dm' AND NOT (tk.has_author OR g.jid IS NOT NULL))
  OR ($6 = 'group' AND (tk.has_author OR g.jid IS NOT NULL)))`;

export async function getTimeseries(
  pool: Pool,
  p: {
    workspaceId: string;
    numberId?: number;
    since: string;
    until: string;
    periodBasis?: 'arrival' | 'activity';
    kind?: 'dm' | 'group' | 'all';
    bucket: 'day' | 'week';
  },
): Promise<{ series: TimeseriesPoint[] }> {
  const periodBasis = p.periodBasis ?? 'arrival';
  const kind = p.kind ?? 'all';
  const bucketUnit = p.bucket === 'week' ? 'week' : 'day'; // whitelist antes de interpolar
  // $1=ws, $2=numberId|null, $3=since, $4=until, $5=bucketUnit (não interpolado — ver abaixo), $6=kind
  const params = [p.workspaceId, p.numberId ?? null, p.since, p.until, bucketUnit, kind];
  const numFilter = `AND ($2::int IS NULL OR m.whatsapp_number_id = $2)`;

  const sqlText = periodBasis === 'arrival'
    ? `
      WITH threads AS (
        SELECT m.identifier, MIN(m.created_at) AS first_at, bool_or(m.author IS NOT NULL) AS has_author
          FROM messages m
         WHERE m.workspace_id = $1 ${numFilter}
         GROUP BY m.identifier
        HAVING MIN(m.created_at) >= $3::timestamptz AND MIN(m.created_at) <= $4::timestamptz
      )
      SELECT date_trunc($5, tk.first_at AT TIME ZONE 'America/Sao_Paulo')::date AS bucket,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE tm.is_lead IS NULL OR tm.is_lead = TRUE)::int AS leads
        FROM threads tk
        LEFT JOIN LATERAL (
          SELECT g2.jid FROM whatsapp_groups g2
           WHERE g2.jid = tk.identifier AND ($2::int IS NULL OR g2.whatsapp_number_id = $2) LIMIT 1
        ) g ON TRUE
        LEFT JOIN LATERAL (
          SELECT tm2.is_lead FROM whatsapp_thread_meta tm2
           WHERE tm2.identifier = tk.identifier AND ($2::int IS NULL OR tm2.whatsapp_number_id = $2) LIMIT 1
        ) tm ON TRUE
       WHERE ${KIND_PREDICATE}
       GROUP BY 1 ORDER BY 1`
    : `
      WITH thread_kind AS (
        SELECT m.identifier, bool_or(m.author IS NOT NULL) AS has_author
          FROM messages m
         WHERE m.workspace_id = $1 ${numFilter}
         GROUP BY m.identifier
      ),
      active AS (
        SELECT DISTINCT m.identifier, date_trunc($5, m.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS bucket
          FROM messages m
         WHERE m.workspace_id = $1 ${numFilter}
           AND m.created_at >= $3::timestamptz AND m.created_at <= $4::timestamptz
      )
      SELECT a.bucket,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE tm.is_lead IS NULL OR tm.is_lead = TRUE)::int AS leads
        FROM active a
        JOIN thread_kind tk ON tk.identifier = a.identifier
        LEFT JOIN LATERAL (
          SELECT g2.jid FROM whatsapp_groups g2
           WHERE g2.jid = a.identifier AND ($2::int IS NULL OR g2.whatsapp_number_id = $2) LIMIT 1
        ) g ON TRUE
        LEFT JOIN LATERAL (
          SELECT tm2.is_lead FROM whatsapp_thread_meta tm2
           WHERE tm2.identifier = a.identifier AND ($2::int IS NULL OR tm2.whatsapp_number_id = $2) LIMIT 1
        ) tm ON TRUE
       WHERE ${KIND_PREDICATE}
       GROUP BY a.bucket ORDER BY a.bucket`;

  const res = await pool.query(sqlText, params);
  const byBucket = new Map<string, { total: number; leads: number }>();
  for (const r of res.rows) {
    const key = r.bucket instanceof Date ? r.bucket.toISOString().slice(0, 10) : String(r.bucket).slice(0, 10);
    byBucket.set(key, { total: Number(r.total), leads: Number(r.leads) });
  }

  // Zero-fill em JS: caminha de trunc(since) até until em passos de bucket,
  // em datas locais SP (data-only — sem aritmética de hora).
  const spDate = (iso: string): Date => {
    const d = new Date(new Date(iso).getTime() - 3 * 60 * 60 * 1000); // UTC→SP (-03:00 fixo)
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  };
  const truncToBucket = (d: Date): Date => {
    if (bucketUnit === 'day') return d;
    const dow = (d.getUTCDay() + 6) % 7; // segunda=0 (date_trunc('week') é ISO/segunda)
    return new Date(d.getTime() - dow * 86_400_000);
  };
  const stepMs = bucketUnit === 'week' ? 7 * 86_400_000 : 86_400_000;
  const series: TimeseriesPoint[] = [];
  const end = spDate(p.until);
  for (let cur = truncToBucket(spDate(p.since)); cur <= end; cur = new Date(cur.getTime() + stepMs)) {
    const key = cur.toISOString().slice(0, 10);
    const hit = byBucket.get(key);
    series.push({ bucketStart: key, total: hit?.total ?? 0, leads: hit?.leads ?? 0 });
  }
  return { series };
}
