/**
 * src/whatsapp/timeseries.ts
 * Série temporal de conversas para /whatsapp/stats/timeseries.
 *
 * arrival: thread ancora no bucket do MIN(created_at) (conversas NOVAS por bucket).
 * activity: thread conta em cada bucket onde teve mensagem (conversas ATIVAS).
 *
 * FUSO — O SQL É A ÚNICA AUTORIDADE (America/Sao_Paulo):
 *   - A chave do bucket sai do SQL como TEXTO (`to_char(..., 'YYYY-MM-DD')`), nunca
 *     como `date`. Um `date` do pg é convertido pelo pg-types num `Date` de JS na
 *     meia-noite LOCAL do processo; relê-lo como UTC (`toISOString`) desloca o dia
 *     sempre que o offset do processo for > 0 (ex.: TZ=Europe/Berlin) — o bug-trap
 *     K1 do projeto na direção inversa, e SILENCIOSO (o lookup do zero-fill erra e
 *     devolve 0 em vez de estourar).
 *   - O zero-fill vem de `generate_series` derivado da MESMA expressão de fuso, e
 *     não de aritmética de data em JS (que precisaria assumir um offset fixo e
 *     divergiria do tz database real).
 * Não introduza uma segunda noção de "que dia SP é este" fora deste SQL.
 *
 * Payload agregado: sem identifier e sem texto (minimização LGPD).
 * leads segue a semântica de stats.ts: sem thread_meta OU is_lead=TRUE ⇒ lead.
 */
import type { Pool } from 'pg';
// Autoridade única do escopo de workspace nos laterais de metadado (thread_meta /
// groups são chaveados por identifier, que não é único entre workspaces).
// Definido em stats.ts, de onde este módulo já herda a semântica de `leads`.
import { WORKSPACE_NUMBERS } from './sql-scope.js';

export type TimeseriesPoint = { bucketStart: string; total: number; leads: number; oportunidades: number };

/**
 * Oportunidade = thread com lead_stage em (qualificado, cliente) — mesma
 * definição do funil do painel (byStage.qualificado + byStage.cliente em
 * stats.ts). Alterar aqui exige alterar lá (e vice-versa).
 */
const OPORT_FILTER = `COUNT(*) FILTER (WHERE tm.lead_stage IN ('qualificado', 'cliente'))::int AS oportunidades`;

const KIND_PREDICATE = `($6 = 'all'
  OR ($6 = 'dm' AND NOT (tk.has_author OR g.jid IS NOT NULL))
  OR ($6 = 'group' AND (tk.has_author OR g.jid IS NOT NULL)))`;

/**
 * Buckets contíguos de [since, until] — a fonte do zero-fill.
 * `until` é INCLUSIVO (contrato do worker, diferente do bloquim-api): truncar o
 * `until` ao bucket faz o generate_series emitir o bucket que o contém.
 */
const BUCKETS_CTE = `
  buckets AS (
    SELECT to_char(gs, 'YYYY-MM-DD') AS bucket
      FROM generate_series(
             date_trunc($5::text, $3::timestamptz AT TIME ZONE 'America/Sao_Paulo'),
             date_trunc($5::text, $4::timestamptz AT TIME ZONE 'America/Sao_Paulo'),
             ('1 ' || $5::text)::interval
           ) AS gs
  )`;

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
  // Whitelist do bucket: defense-in-depth, NÃO guarda de injeção — $5 é bind param
  // e nunca é interpolado. Mantém o valor dentro do domínio que date_trunc/
  // generate_series aceitam, mesmo se um caller pular a validação da rota.
  const bucketUnit = p.bucket === 'week' ? 'week' : 'day';
  // $1=ws, $2=numberId|null, $3=since, $4=until, $5=bucketUnit, $6=kind
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
      ),
      agg AS (
        SELECT to_char(date_trunc($5::text, tk.first_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS bucket,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE tm.is_lead IS NULL OR tm.is_lead = TRUE)::int AS leads,
               ${OPORT_FILTER}
          FROM threads tk
          LEFT JOIN LATERAL (
            SELECT g2.jid FROM whatsapp_groups g2
             WHERE g2.jid = tk.identifier
               AND g2.whatsapp_number_id IN ${WORKSPACE_NUMBERS}
               AND ($2::int IS NULL OR g2.whatsapp_number_id = $2) LIMIT 1
          ) g ON TRUE
          LEFT JOIN LATERAL (
            SELECT tm2.is_lead, tm2.lead_stage FROM whatsapp_thread_meta tm2
             WHERE tm2.identifier = tk.identifier
               AND tm2.whatsapp_number_id IN ${WORKSPACE_NUMBERS}
               AND ($2::int IS NULL OR tm2.whatsapp_number_id = $2)
             ORDER BY tm2.whatsapp_number_id LIMIT 1
          ) tm ON TRUE
         WHERE ${KIND_PREDICATE}
         GROUP BY 1
      ),
      ${BUCKETS_CTE}
      SELECT b.bucket, COALESCE(a.total, 0)::int AS total, COALESCE(a.leads, 0)::int AS leads,
             COALESCE(a.oportunidades, 0)::int AS oportunidades
        FROM buckets b LEFT JOIN agg a ON a.bucket = b.bucket
       ORDER BY b.bucket`
    : `
      WITH thread_kind AS (
        SELECT m.identifier, bool_or(m.author IS NOT NULL) AS has_author
          FROM messages m
         WHERE m.workspace_id = $1 ${numFilter}
         GROUP BY m.identifier
      ),
      active AS (
        SELECT DISTINCT m.identifier, date_trunc($5::text, m.created_at AT TIME ZONE 'America/Sao_Paulo') AS bucket_ts
          FROM messages m
         WHERE m.workspace_id = $1 ${numFilter}
           AND m.created_at >= $3::timestamptz AND m.created_at <= $4::timestamptz
      ),
      agg AS (
        SELECT to_char(a.bucket_ts, 'YYYY-MM-DD') AS bucket,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE tm.is_lead IS NULL OR tm.is_lead = TRUE)::int AS leads,
               ${OPORT_FILTER}
          FROM active a
          JOIN thread_kind tk ON tk.identifier = a.identifier
          LEFT JOIN LATERAL (
            SELECT g2.jid FROM whatsapp_groups g2
             WHERE g2.jid = a.identifier
               AND g2.whatsapp_number_id IN ${WORKSPACE_NUMBERS}
               AND ($2::int IS NULL OR g2.whatsapp_number_id = $2) LIMIT 1
          ) g ON TRUE
          LEFT JOIN LATERAL (
            SELECT tm2.is_lead, tm2.lead_stage FROM whatsapp_thread_meta tm2
             WHERE tm2.identifier = a.identifier
               AND tm2.whatsapp_number_id IN ${WORKSPACE_NUMBERS}
               AND ($2::int IS NULL OR tm2.whatsapp_number_id = $2)
             ORDER BY tm2.whatsapp_number_id LIMIT 1
          ) tm ON TRUE
         WHERE ${KIND_PREDICATE}
         GROUP BY 1
      ),
      ${BUCKETS_CTE}
      SELECT b.bucket, COALESCE(a.total, 0)::int AS total, COALESCE(a.leads, 0)::int AS leads,
             COALESCE(a.oportunidades, 0)::int AS oportunidades
        FROM buckets b LEFT JOIN agg a ON a.bucket = b.bucket
       ORDER BY b.bucket`;

  const res = await pool.query(sqlText, params);
  // `bucket` já vem como texto 'YYYY-MM-DD' e o zero-fill já foi feito no SQL:
  // esta camada só renomeia colunas — sem parse de data, sem preenchimento.
  return {
    series: res.rows.map((r): TimeseriesPoint => ({
      bucketStart: String(r.bucket),
      total: Number(r.total),
      leads: Number(r.leads),
      oportunidades: Number(r.oportunidades),
    })),
  };
}
