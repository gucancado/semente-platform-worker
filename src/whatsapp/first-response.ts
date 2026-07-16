/**
 * src/whatsapp/first-response.ts
 * Tempo de 1ª resposta por thread: 1º inbound → 1º outbound POSTERIOR.
 *
 * LIVE-ONLY (ingest_source='live'): created_at de live é hora de recepção no
 * worker (≈ tempo real); backfill usa hora real do WhatsApp — misturar as duas
 * bases numa mesma duração distorce a métrica (spec fase 2, caveat 1).
 *
 * Janela (since/until, inclusiva nos dois lados — contrato do worker) recorta
 * pelo PRIMEIRO INBOUND da thread, não por qualquer mensagem da thread.
 *
 * Payload agregado: sem identifier e sem texto (minimização LGPD).
 *
 * DM-scoped por default (kind='dm'): grupos são ruidosos p/ SLA de atendimento.
 *
 * Escopo de workspace no lateral de whatsapp_groups (lição da Task 3, bug real
 * achado por reviewer): `identifier` (JID) NÃO é único entre workspaces. O
 * padrão frouxo `($2::int IS NULL OR g2.whatsapp_number_id = $2)` sozinho vira
 * no-op quando $2 (numberId) é omitido — uma linha de whatsapp_groups de OUTRO
 * workspace com o mesmo JID reclassificaria erradamente uma DM como grupo
 * (excluída do default kind='dm', zerando answered/unanswered). Usa a mesma
 * autoridade compartilhada `WORKSPACE_NUMBERS` (sql-scope.ts) — não reinventa
 * o escopo.
 */
import type { Pool } from 'pg';
import { WORKSPACE_NUMBERS } from './sql-scope.js';

export type FirstResponseStats = {
  answered: number;
  unanswered: number;
  avgMinutes: number | null;
  medianMinutes: number | null;
  p90Minutes: number | null;
};

const round1 = (v: unknown): number | null => (v == null ? null : Math.round(Number(v) * 10) / 10);

export async function getFirstResponse(
  pool: Pool,
  p: { workspaceId: string; numberId?: number; since?: string; until?: string; kind?: 'dm' | 'group' | 'all' },
): Promise<FirstResponseStats> {
  const kind = p.kind ?? 'dm'; // DM-scoped por default (grupos são ruidosos p/ SLA)
  // $1=ws, $2=numberId|null, $3=since|null, $4=until|null, $5=kind
  const params = [p.workspaceId, p.numberId ?? null, p.since ?? null, p.until ?? null, kind];
  const numFilter = `AND ($2::int IS NULL OR m.whatsapp_number_id = $2)`;

  const res = await pool.query(
    `
    WITH thread_kind AS (
      SELECT m.identifier, bool_or(m.author IS NOT NULL) AS has_author
        FROM messages m
       WHERE m.workspace_id = $1 ${numFilter}
       GROUP BY m.identifier
    ),
    fr AS (
      SELECT m.identifier,
             MIN(m.created_at) FILTER (WHERE m.direction = 'inbound') AS first_in
        FROM messages m
       WHERE m.workspace_id = $1 ${numFilter} AND m.ingest_source = 'live'
       GROUP BY m.identifier
    ),
    resp AS (
      SELECT f.identifier, f.first_in,
             (SELECT MIN(m2.created_at) FROM messages m2
               WHERE m2.workspace_id = $1
                 AND ($2::int IS NULL OR m2.whatsapp_number_id = $2)
                 AND m2.identifier = f.identifier
                 AND m2.direction = 'outbound'
                 AND m2.ingest_source = 'live'
                 AND m2.created_at > f.first_in) AS first_out
        FROM fr f
       WHERE f.first_in IS NOT NULL
         AND ($3::timestamptz IS NULL OR f.first_in >= $3)
         AND ($4::timestamptz IS NULL OR f.first_in <= $4)
    )
    SELECT COUNT(*) FILTER (WHERE r.first_out IS NOT NULL)::int AS answered,
           COUNT(*) FILTER (WHERE r.first_out IS NULL)::int AS unanswered,
           AVG(EXTRACT(EPOCH FROM (r.first_out - r.first_in)) / 60.0) FILTER (WHERE r.first_out IS NOT NULL) AS avg_minutes,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (r.first_out - r.first_in)) / 60.0)
             FILTER (WHERE r.first_out IS NOT NULL) AS median_minutes,
           PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (r.first_out - r.first_in)) / 60.0)
             FILTER (WHERE r.first_out IS NOT NULL) AS p90_minutes
      FROM resp r
      JOIN thread_kind tk ON tk.identifier = r.identifier
      LEFT JOIN LATERAL (
        SELECT g2.jid FROM whatsapp_groups g2
         WHERE g2.jid = r.identifier
           AND g2.whatsapp_number_id IN ${WORKSPACE_NUMBERS}
           AND ($2::int IS NULL OR g2.whatsapp_number_id = $2) LIMIT 1
      ) g ON TRUE
     WHERE ($5 = 'all'
        OR ($5 = 'dm' AND NOT (tk.has_author OR g.jid IS NOT NULL))
        OR ($5 = 'group' AND (tk.has_author OR g.jid IS NOT NULL)))
    `,
    params,
  );
  const row = res.rows[0] ?? {};
  return {
    answered: Number(row.answered ?? 0),
    unanswered: Number(row.unanswered ?? 0),
    avgMinutes: round1(row.avg_minutes),
    medianMinutes: round1(row.median_minutes),
    p90Minutes: round1(row.p90_minutes),
  };
}
