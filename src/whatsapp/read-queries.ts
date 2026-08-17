import type { Pool } from 'pg';
import { leadFilterSql, type LeadStatus } from './lead-filter.js';
import { qualificationLabel } from './opportunity-core.js';
import { resolveIsQualifiedFilter } from './opportunities.js';
import type { BoardColumn } from './opportunity-core.js';
import { BOARD_COLUMN_CASE_SQL, isBoardColumn } from './board.js';

/**
 * Converte o alias string `opp_qualification` (qualificado/desqualificado/indefinido)
 * num TOKEN de texto pro predicado SQL sobre is_qualified (fonte v3):
 *   'true' → is_qualified=TRUE · 'false' → FALSE · 'null' → IS NULL (indefinido).
 * `null` (retorno) = sem filtro. Reusa `resolveIsQualifiedFilter` (mesma conversão do
 * data layer) — string inválida cai no default undefined → sem filtro. Exportada p/
 * teste puro da conversão.
 */
export function oppQualificationToken(qualification: string | undefined): string | null {
  const isQ = resolveIsQualifiedFilter({ qualification });
  if (isQ === undefined) return null;
  return isQ === null ? 'null' : String(isQ); // true→'true' · false→'false' · null→'null'
}

/**
 * Parseia `opp_column=` (Task C3, §10): CSV multi-valor (ex.:
 * "novas_conversas,ganhos") ou array (repeated query key) pro array de
 * `BoardColumn` validado — casa a conversa pela coluna do board da opp MAIS
 * RECENTE do par (união, `= ANY`). Retorna:
 *  - `undefined`: filtro ausente/vazio (sem filtro; whitespace-only conta como vazio).
 *  - `BoardColumn[]`: 1+ valores válidos (trim, vazios descartados).
 *  - `null`: SENTINELA — pelo menos um valor fora do enum das 4 colunas
 *    (`isBoardColumn`); o caller (read-routes.ts) 400s nesse caso.
 * Exportada p/ teste puro da conversão (mesmo padrão de `oppQualificationToken`).
 */
export function parseOppColumnCsv(raw: string | string[] | undefined): BoardColumn[] | undefined | null {
  if (raw === undefined) return undefined;
  const parts = Array.isArray(raw) ? raw : raw.split(',');
  const values = parts.map((v) => String(v).trim()).filter(Boolean);
  if (values.length === 0) return undefined;
  for (const v of values) {
    if (!isBoardColumn(v)) return null;
  }
  return values as BoardColumn[];
}

export type Thread = {
  identifier: string;
  lastAt: string;
  lastText: string | null;
  count: number;
  kind: 'dm' | 'group';
  name: string | null;
  /** Tri-state v3: 'lead' (is_lead=TRUE) · 'not_lead' (FALSE) · 'indefinido' (NULL/sem meta). */
  leadStatus: 'lead' | 'not_lead' | 'indefinido';
  leadStage: string | null;
  leadTemperature: string | null;
  leadSource: string | null;
  disqualifyReason: string | null;
  tags: string[];
  opportunities: OpportunitySummary;
  /** Present only when `includeFirstInboundText` was requested. Null if no inbound message exists. */
  firstInboundText?: string | null;
};
export type OpportunityTag = { id: number; name: string; color: string };
export type OpportunitySummary = {
  count: number;
  /**
   * Resumo da opp mais recente. v3 contract (mig 053): expõe `isQualified`
   * (boolean|null, ÚNICA fonte da verdade — a coluna legada `qualification` foi
   * dropada do banco) e `lossReason`; `qualification` (string) segue exposta na
   * resposta, mas SEMPRE derivada de is_qualified.
   */
  latest: {
    id: number;
    status: string;
    isQualified: boolean | null;
    lossReason: string | null;
    qualification: string;
    title: string | null;
    tags: OpportunityTag[];
  } | null;
};

/** Deriva o tri-state de leadStatus a partir de is_lead (true/false/null|sem row). */
function deriveLeadStatus(isLead: boolean | null | undefined): 'lead' | 'not_lead' | 'indefinido' {
  if (isLead === true) return 'lead';
  if (isLead === false) return 'not_lead';
  return 'indefinido';
}

function mapOpportunitySummary(r: any): OpportunitySummary {
  if (!r.opportunity_latest) return { count: Number(r.opportunity_count) || 0, latest: null };
  const latest = typeof r.opportunity_latest === 'string'
    ? JSON.parse(r.opportunity_latest)
    : r.opportunity_latest;
  // v3 contract (mig 053): a string `qualification` é SEMPRE derivada de
  // is_qualified — o jsonb do LATERAL não traz mais a coluna legada.
  const isQualified = latest.is_qualified === undefined ? null : latest.is_qualified;
  return {
    count: Number(r.opportunity_count) || 0,
    latest: {
      id: Number(latest.id),
      status: latest.status,
      isQualified,
      lossReason: latest.loss_reason ?? null,
      qualification: qualificationLabel(isQualified),
      title: latest.title ?? null,
      tags: (latest.tags ?? []).map((t: any) => ({ id: Number(t.id), name: t.name, color: t.color })),
    },
  };
}
function encode(c: { key: string; identifier: string }) { return Buffer.from(JSON.stringify(c)).toString('base64'); }
function decode(s: string): { key: string; identifier: string } { return JSON.parse(Buffer.from(s, 'base64').toString()); }

export async function listThreads(pool: Pool, p: {
  workspaceId: string;
  numberId: number;
  limit: number;
  cursor?: string;
  kind?: 'dm' | 'group' | 'all';
  leadStatus?: LeadStatus;
  leadStage?: string;
  leadSource?: string;
  leadTemperature?: string;
  tag?: string;
  /** When true, adds `firstInboundText` to each thread (correlated subquery, opt-in). */
  includeFirstInboundText?: boolean;
  since?: string;
  until?: string;
  periodBasis?: 'arrival' | 'activity';
  opp?: 'with' | 'without';
  oppStatus?: string;
  oppQualification?: string;
  oppTagId?: string | number;
  /** Task C3 (§10): união (CSV) de colunas do board — casa pela opp MAIS RECENTE do par. */
  oppColumn?: BoardColumn[];
}) {
  const cur = p.cursor ? decode(p.cursor) : null;
  const kind = p.kind ?? 'all';
  const leadStatus = p.leadStatus ?? 'all';
  const includeFirstInbound = p.includeFirstInboundText === true;

  // Resolve period mode. arrivalMode is only active when there is an actual window;
  // without bounds the behavior must be identical to today (backward compat).
  const periodBasis = p.periodBasis ?? 'arrival';
  const hasWindow = (p.since != null) || (p.until != null);
  const arrivalMode = periodBasis === 'arrival' && hasWindow;

  // The cursor carries the ordering key (either min_created or last_at) + identifier.
  // $3 is the ordering-key bound from the cursor; $4 is identifier.
  const orderCol = arrivalMode ? 'a.min_created' : 'a.last_at';

  // Period filter SQL fragment (resolved in JS, not a SQL param).
  // With both bounds null, both branches reduce to a no-op (TRUE).
  const periodFilterSql = periodBasis === 'activity'
    ? 'AND a.in_window'
    : 'AND ($11::timestamptz IS NULL OR a.min_created >= $11) AND ($12::timestamptz IS NULL OR a.min_created <= $12)';

  // $1=numberId $2=workspaceId $3=cursor.key $4=cursor.identifier $5=limit $6=kind
  // $7=leadStage $8=leadSource $9=tag
  const params: unknown[] = [
    p.numberId,
    p.workspaceId,
    cur?.key ?? null,
    cur?.identifier ?? null,
    p.limit,
    kind,
    p.leadStage ?? null,
    p.leadSource ?? null,
    p.tag ?? null,
  ];

  // $10 = includeFirstInbound flag. This boolean is ALWAYS pushed at this fixed
  // position (unconditionally) so the `$10` placeholder in the SQL is always bound.
  // Do NOT make this push conditional — the correlated subquery is gated at query
  // time via `CASE WHEN $10::boolean THEN (...) ELSE NULL END`, so when the flag is
  // false the subquery is skipped by the planner while $10 still resolves cleanly.
  params.push(includeFirstInbound);
  // $10 is now bound → used as CASE WHEN $10 THEN (...) ELSE NULL END

  // $11=since $12=until — appended AFTER $10 at fixed positions.
  params.push(p.since ?? null);
  params.push(p.until ?? null);
  // $13 = leadTemperature (filtro opcional; null = sem filtro)
  params.push(p.leadTemperature ?? null);
  // $14=opp $15=oppStatus $16=oppQualification(token is_qualified) $17=oppTagId
  // oppQualification (alias string) é convertido pro token do predicado sobre is_qualified.
  params.push(p.opp ?? null, p.oppStatus ?? null, oppQualificationToken(p.oppQualification), p.oppTagId ?? null);
  // $18 = oppColumn (Task C3): array de BoardColumn ou null (sem filtro). Casa via
  // LATERAL `opp_col` abaixo, que projeta a MESMA CASE (BOARD_COLUMN_CASE_SQL,
  // fonte única de board.ts) sobre a opp mais recente do par (created_at DESC, id DESC).
  params.push(p.oppColumn && p.oppColumn.length > 0 ? p.oppColumn : null);

  const { rows } = await pool.query(
    `WITH agg AS (
       SELECT m.identifier,
              MAX(m.created_at) AS last_at,
              MIN(m.created_at) AS min_created,
              COUNT(*)::int AS count,
              (ARRAY_AGG(m.text ORDER BY m.created_at DESC))[1] AS last_text,
              bool_or(m.author IS NOT NULL) AS has_author,
              bool_or(($11::timestamptz IS NULL OR m.created_at >= $11) AND ($12::timestamptz IS NULL OR m.created_at <= $12)) AS in_window
         FROM messages m
        WHERE m.whatsapp_number_id = $1 AND m.workspace_id = $2
        GROUP BY m.identifier
     )
     SELECT a.identifier, a.last_at, a.min_created, a.count, a.last_text,
            (a.has_author OR g.jid IS NOT NULL) AS is_group,
            tm.is_lead,
            tm.lead_stage, tm.lead_temperature, tm.lead_source, tm.disqualify_reason,
            CASE WHEN (a.has_author OR g.jid IS NOT NULL) THEN g.subject
                 -- push_name de evento fromMe é o dono do número, não o contato —
                 -- só vale o push_name de eventos com mensagem inbound correspondente.
                 ELSE (SELECT w.push_name FROM webhook_logs w
                        JOIN messages mi ON mi.evolution_event_id = w.evolution_event_id
                                        AND mi.whatsapp_number_id = w.whatsapp_number_id
                        WHERE w.whatsapp_number_id = $1 AND w.identifier = a.identifier
                          AND w.push_name IS NOT NULL AND mi.direction = 'inbound'
                        ORDER BY w.created_at DESC LIMIT 1)
            END AS name,
            COALESCE(
              (SELECT ARRAY_AGG(t.tag ORDER BY t.tag)
                 FROM whatsapp_thread_tags t
                WHERE t.whatsapp_number_id = $1 AND t.identifier = a.identifier),
              '{}'::text[]
            ) AS tags,
            COALESCE(os.opportunity_count, 0)::int AS opportunity_count,
            os.opportunity_latest,
            CASE WHEN $10::boolean THEN (
              SELECT mi.text
                FROM messages mi
               WHERE mi.whatsapp_number_id = $1
                 AND mi.workspace_id = $2
                 AND mi.identifier = a.identifier
                 AND mi.direction = 'inbound'
               ORDER BY mi.created_at ASC
               LIMIT 1
            ) ELSE NULL END AS first_inbound_text
       FROM agg a
       LEFT JOIN whatsapp_groups g
         ON g.whatsapp_number_id = $1 AND g.jid = a.identifier
       LEFT JOIN whatsapp_thread_meta tm
         ON tm.whatsapp_number_id = $1 AND tm.identifier = a.identifier
       -- EXPLAIN rationale: the lateral is evaluated only for the <=50 selected
       -- thread candidates and probes idx_whatsapp_opportunities_number_identifier;
       -- tags are aggregated inside the same set-based SQL, never queried per row.
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS opportunity_count,
                (ARRAY_AGG(
                  jsonb_build_object(
                    'id', o.id, 'status', o.status,
                    'is_qualified', o.is_qualified, 'loss_reason', o.loss_reason,
                    'title', o.title, 'tags', COALESCE(ot.tags, '[]'::jsonb)
                  ) ORDER BY o.created_at DESC, o.id DESC
                ))[1] AS opportunity_latest
           FROM whatsapp_opportunities o
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color)
                              ORDER BY t.name, t.id) AS tags
               FROM whatsapp_opportunity_tags x
               JOIN whatsapp_tags t ON t.id = x.tag_id
              WHERE x.opportunity_id = o.id
           ) ot ON TRUE
          WHERE o.whatsapp_number_id = $1 AND o.identifier = a.identifier
       ) os ON TRUE
       -- Task C3 (§10): board_column da opp MAIS RECENTE do par (created_at DESC, id
       -- DESC — mesma definição de "mais recente" do LATERAL os acima), via a MESMA
       -- CASE de board.ts (BOARD_COLUMN_CASE_SQL, fonte única). FROM próprio
       -- (whatsapp_opportunities o + whatsapp_thread_meta tm2) espelha o BOARD_OPPS_CTE
       -- de board.ts p/ os nomes sem prefixo (is_lead/status/is_qualified/loss_reason)
       -- resolverem sem ambiguidade. Par sem opp → subquery não devolve linha →
       -- opp_board_column NULL → nunca casa um filtro ativo (par sem opp não tem coluna).
       -- Fix round 1 (review): a subquery correlacionada (reabre whatsapp_opportunities+
       -- thread_meta por thread) fica atrás de CASE WHEN $18 IS NOT NULL — mesmo gate de
       -- $10/includeFirstInboundText acima — pra rota quente (sem opp_column, caso
       -- majoritário) NÃO pagar esse custo por thread da página. Otimização futura (YAGNI
       -- agora): computar board_column a partir do jsonb já materializado pelo LATERAL os
       -- (mesma opp mais recente) em vez de reabrir as tabelas aqui — mexe em jsonb de rota
       -- quente, deixado fora deste fix mínimo.
       LEFT JOIN LATERAL (
         SELECT CASE WHEN $18::text[] IS NOT NULL THEN (
                  SELECT (${BOARD_COLUMN_CASE_SQL})
                    FROM whatsapp_opportunities o
                    LEFT JOIN whatsapp_thread_meta tm2
                      ON tm2.whatsapp_number_id = o.whatsapp_number_id AND tm2.identifier = o.identifier
                   WHERE o.whatsapp_number_id = $1 AND o.identifier = a.identifier
                   ORDER BY o.created_at DESC, o.id DESC
                   LIMIT 1
                ) ELSE NULL END AS opp_board_column
       ) opp_col ON TRUE
      WHERE ($3::timestamptz IS NULL
          OR date_trunc('milliseconds', ${orderCol}) < $3
          OR (date_trunc('milliseconds', ${orderCol}) = $3 AND a.identifier > $4))
        AND ($6 = 'all'
          OR ($6 = 'group' AND (a.has_author OR g.jid IS NOT NULL))
          OR ($6 = 'dm' AND NOT (a.has_author OR g.jid IS NOT NULL)))
        AND ${leadFilterSql(leadStatus)}
        AND ($7::text IS NULL
             OR ($7 = 'none' AND tm.lead_stage IS NULL)
             OR ($7 <> 'none' AND tm.lead_stage = $7))
        AND ($8::text IS NULL OR tm.lead_source = $8)
        AND ($13::text IS NULL OR tm.lead_temperature = $13)
        AND ($9::text IS NULL OR EXISTS (
              SELECT 1 FROM whatsapp_thread_tags t
               WHERE t.whatsapp_number_id = $1 AND t.identifier = a.identifier AND t.tag = $9
            ))
        AND ($14::text IS NULL
             OR ($14 = 'with' AND COALESCE(os.opportunity_count, 0) > 0)
             OR ($14 = 'without' AND COALESCE(os.opportunity_count, 0) = 0))
        -- oppStatus dirige o toggle Em andamento/Perdidas (spec §2): quando o filtro
        -- é 'em_andamento' ou 'perdido', as GANHAS entram sempre (paridade com o
        -- kanban, onde 'ganhos' ignora o toggle). Filtro por 'ganho' segue exato.
        AND ($15::text IS NULL OR EXISTS (
              SELECT 1 FROM whatsapp_opportunities oflt
               WHERE oflt.whatsapp_number_id = $1 AND oflt.identifier = a.identifier
                 AND (oflt.status = $15
                      OR ($15 IN ('em_andamento', 'perdido') AND oflt.status = 'ganho'))
            ))
        AND ($16::text IS NULL OR EXISTS (
              SELECT 1 FROM whatsapp_opportunities oflt
               WHERE oflt.whatsapp_number_id = $1 AND oflt.identifier = a.identifier
                 AND oflt.is_qualified IS NOT DISTINCT FROM
                     (CASE $16 WHEN 'true' THEN TRUE WHEN 'false' THEN FALSE ELSE NULL END)
            ))
        AND ($17::bigint IS NULL OR EXISTS (
              SELECT 1 FROM whatsapp_opportunities oflt
              JOIN whatsapp_opportunity_tags oft ON oft.opportunity_id = oflt.id
               WHERE oflt.whatsapp_number_id = $1 AND oflt.identifier = a.identifier
                 AND oft.tag_id = $17
            ))
        AND ($18::text[] IS NULL OR opp_col.opp_board_column = ANY($18))
        ${periodFilterSql}
      ORDER BY date_trunc('milliseconds', ${orderCol}) DESC, a.identifier ASC
      LIMIT $5`,
    params);
  const threads: Thread[] = rows.map(r => {
    const t: Thread = {
      identifier: r.identifier, lastAt: r.last_at.toISOString(), lastText: r.last_text, count: r.count,
      kind: r.is_group ? 'group' : 'dm', name: r.name ?? null,
      leadStatus: deriveLeadStatus(r.is_lead),
      leadStage: r.lead_stage ?? null,
      leadTemperature: r.lead_temperature ?? null,
      leadSource: r.lead_source ?? null,
      disqualifyReason: r.disqualify_reason ?? null,
      tags: r.tags ?? [],
      opportunities: mapOpportunitySummary(r),
    };
    if (includeFirstInbound) {
      t.firstInboundText = r.first_inbound_text ?? null;
    }
    return t;
  });
  const lastRow = rows[rows.length - 1];
  const nextCursor = rows.length === p.limit && lastRow
    ? encode({ key: (arrivalMode ? lastRow.min_created : lastRow.last_at).toISOString(), identifier: lastRow.identifier })
    : null;
  return { threads, nextCursor };
}

export type Msg = { id: number; direction: string; text: string | null; agent: string | null; createdAt: string; author: string | null; authorName: string | null; kind: string; transcriptionStatus: string | null; mediaDurationS: number | null; hasMedia: boolean };
export async function listThreadMessages(pool: Pool, p: { workspaceId: string; numberId: number; identifier: string; limit: number; cursor?: string; since?: string; until?: string; order?: 'asc' | 'desc' }) {
  const before = p.cursor ? Buffer.from(p.cursor, 'base64').toString() : null;
  // order 'desc' (default) = mais novas primeiro (compat). 'asc' = mais antigas primeiro (paginação p/ frente).
  const asc = p.order === 'asc';
  const cmp = asc ? '>' : '<';
  const dir = asc ? 'ASC' : 'DESC';
  const { rows } = await pool.query(
    `SELECT m.id, m.direction, m.text, m.agent, m.created_at, m.author,
            m.kind, m.transcription_status, m.media_duration_s, m.media_key,
            w.push_name AS author_name
       FROM messages m
       LEFT JOIN webhook_logs w
         ON w.evolution_event_id = m.evolution_event_id
        AND w.whatsapp_number_id = m.whatsapp_number_id
        AND m.direction = 'inbound'
      WHERE m.whatsapp_number_id = $1 AND m.identifier = $2 AND m.workspace_id = $7
        AND ($3::timestamptz IS NULL OR m.created_at ${cmp} $3)
        AND ($5::timestamptz IS NULL OR m.created_at >= $5)
        AND ($6::timestamptz IS NULL OR m.created_at <= $6)
      ORDER BY m.created_at ${dir} LIMIT $4`,
    [p.numberId, p.identifier, before, p.limit, p.since ?? null, p.until ?? null, p.workspaceId]);
  const messages: Msg[] = rows.map(r => ({ id: Number(r.id), direction: r.direction, text: r.text, agent: r.agent, createdAt: r.created_at.toISOString(), author: r.author, authorName: r.author_name, kind: r.kind, transcriptionStatus: r.transcription_status, mediaDurationS: r.media_duration_s, hasMedia: r.media_key != null }));
  const lastMsg = messages.at(-1);
  const nextCursor = messages.length === p.limit && lastMsg ? Buffer.from(lastMsg.createdAt).toString('base64') : null;
  return { messages, nextCursor };
}

export type SearchHit = {
  identifier: string;
  kind: 'dm' | 'group';
  name: string | null;
  matchCount: number;
  lastMatchAt: string;
  snippet: string;
  /** Tri-state v3: 'lead' (is_lead=TRUE) · 'not_lead' (FALSE) · 'indefinido' (NULL/sem meta). */
  leadStatus: 'lead' | 'not_lead' | 'indefinido';
  leadStage: string | null;
  leadTemperature: string | null;
  leadSource: string | null;
  disqualifyReason: string | null;
  tags: string[];
  opportunities: OpportunitySummary;
};

export async function searchThreads(pool: Pool, p: {
  workspaceId: string;
  numberId: number;
  query: string;
  since?: string;
  until?: string;
  kind?: 'dm' | 'group' | 'all';
  leadStatus?: LeadStatus;
  limit?: number;
  leadStage?: string;
  leadSource?: string;
  tag?: string;
  opp?: 'with' | 'without';
  oppStatus?: string;
  oppQualification?: string;
  oppTagId?: string | number;
  /** Task C3 (§10): união (CSV) de colunas do board — casa pela opp MAIS RECENTE do par. */
  oppColumn?: BoardColumn[];
  /**
   * Janela de CHEGADA da conversa (toggle Novas/Todas do painel): a conversa entra
   * só se a PRIMEIRA mensagem dela caiu em [arrivalSince, arrivalUntil]. É o mesmo
   * recorte do `periodBasis: 'arrival'` do listThreads/getStats, e é ORTOGONAL a
   * `since`/`until` acima — aqueles recortam quais MENSAGENS casam com a busca
   * (janela do match); estes recortam quais CONVERSAS podem aparecer. Enviar os
   * dois é legítimo: "trecho dito no período X, em conversa nascida no período Y".
   */
  arrivalSince?: string;
  arrivalUntil?: string;
}) {
  const kind = p.kind ?? 'all';
  const leadStatus = p.leadStatus ?? 'all';

  // $1=numberId $2=workspaceId $3=query $4=since $5=until $6=kind $7=limit
  // $8=leadStage $9=leadSource $10=tag … $16=arrivalSince $17=arrivalUntil
  const params: unknown[] = [
    p.numberId,
    p.workspaceId,
    p.query,
    p.since ?? null,
    p.until ?? null,
    kind,
    p.limit ?? 30,
    p.leadStage ?? null,
    p.leadSource ?? null,
    p.tag ?? null,
    p.opp ?? null,
    p.oppStatus ?? null,
    // $13 = token do predicado sobre is_qualified (alias string opp_qualification convertido).
    oppQualificationToken(p.oppQualification),
    p.oppTagId ?? null,
    // $15 = oppColumn (Task C3): array de BoardColumn ou null (sem filtro).
    p.oppColumn && p.oppColumn.length > 0 ? p.oppColumn : null,
    // $16/$17 = janela de chegada da conversa (toggle Novas/Todas).
    p.arrivalSince ?? null,
    p.arrivalUntil ?? null,
  ];

  const { rows } = await pool.query(
    `WITH hits AS (
       SELECT m.identifier,
              COUNT(*)::int AS match_count,
              MAX(m.created_at) AS last_match_at,
              (ARRAY_AGG(m.text ORDER BY m.created_at DESC))[1] AS snippet,
              bool_or(m.author IS NOT NULL) AS has_author
         FROM messages m
        WHERE m.whatsapp_number_id = $1 AND m.workspace_id = $2
          AND m.text ILIKE '%' || $3 || '%'
          AND ($4::timestamptz IS NULL OR m.created_at >= $4)
          AND ($5::timestamptz IS NULL OR m.created_at <= $5)
        GROUP BY m.identifier
     )
     SELECT h.identifier, h.match_count, h.last_match_at, h.snippet,
            (h.has_author OR g.jid IS NOT NULL) AS is_group,
            tm.is_lead,
            tm.lead_stage, tm.lead_temperature, tm.lead_source, tm.disqualify_reason,
            CASE WHEN (h.has_author OR g.jid IS NOT NULL) THEN g.subject
                 ELSE (SELECT w.push_name FROM webhook_logs w
                        JOIN messages mi ON mi.evolution_event_id = w.evolution_event_id
                                        AND mi.whatsapp_number_id = w.whatsapp_number_id
                        WHERE w.whatsapp_number_id = $1 AND w.identifier = h.identifier
                          AND w.push_name IS NOT NULL AND mi.direction = 'inbound'
                        ORDER BY w.created_at DESC LIMIT 1) END AS name,
            COALESCE(
              (SELECT ARRAY_AGG(t.tag ORDER BY t.tag)
                 FROM whatsapp_thread_tags t
                WHERE t.whatsapp_number_id = $1 AND t.identifier = h.identifier),
              '{}'::text[]
            ) AS tags
            , COALESCE(os.opportunity_count, 0)::int AS opportunity_count
            , os.opportunity_latest
       FROM hits h
       LEFT JOIN whatsapp_groups g ON g.whatsapp_number_id = $1 AND g.jid = h.identifier
       LEFT JOIN whatsapp_thread_meta tm ON tm.whatsapp_number_id = $1 AND tm.identifier = h.identifier
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS opportunity_count,
                (ARRAY_AGG(
                  jsonb_build_object(
                    'id', o.id, 'status', o.status,
                    'is_qualified', o.is_qualified, 'loss_reason', o.loss_reason,
                    'title', o.title, 'tags', COALESCE(ot.tags, '[]'::jsonb)
                  ) ORDER BY o.created_at DESC, o.id DESC
                ))[1] AS opportunity_latest
           FROM whatsapp_opportunities o
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color)
                              ORDER BY t.name, t.id) AS tags
               FROM whatsapp_opportunity_tags x
               JOIN whatsapp_tags t ON t.id = x.tag_id
              WHERE x.opportunity_id = o.id
           ) ot ON TRUE
          WHERE o.whatsapp_number_id = $1 AND o.identifier = h.identifier
       ) os ON TRUE
       -- Task C3 (§10): mesmo LATERAL de listThreads, casando pela opp mais recente
       -- do par via BOARD_COLUMN_CASE_SQL (fonte única de board.ts). Fix round 1
       -- (review): subquery gateada atrás de CASE WHEN $15 IS NOT NULL — sem
       -- opp_column (caso majoritário) não reabre whatsapp_opportunities+thread_meta
       -- por hit. Otimização futura (YAGNI agora): derivar do jsonb do LATERAL os
       -- em vez de reabrir as tabelas aqui.
       LEFT JOIN LATERAL (
         SELECT CASE WHEN $15::text[] IS NOT NULL THEN (
                  SELECT (${BOARD_COLUMN_CASE_SQL})
                    FROM whatsapp_opportunities o
                    LEFT JOIN whatsapp_thread_meta tm2
                      ON tm2.whatsapp_number_id = o.whatsapp_number_id AND tm2.identifier = o.identifier
                   WHERE o.whatsapp_number_id = $1 AND o.identifier = h.identifier
                   ORDER BY o.created_at DESC, o.id DESC
                   LIMIT 1
                ) ELSE NULL END AS opp_board_column
       ) opp_col ON TRUE
       -- Chegada da conversa (toggle Novas/Todas): MIN(created_at) sobre TODAS as
       -- mensagens do par — não dá pra derivar da CTE hits, que só agrega as que
       -- casaram com o texto (a 1ª mensagem que casou não é a 1ª da conversa).
       -- Gateado atrás do CASE como o opp_col: sem janela (caso majoritário) não
       -- reabre a tabela messages por hit.
       LEFT JOIN LATERAL (
         SELECT CASE WHEN ($16::timestamptz IS NOT NULL OR $17::timestamptz IS NOT NULL) THEN (
                  SELECT MIN(m2.created_at)
                    FROM messages m2
                   WHERE m2.whatsapp_number_id = $1 AND m2.workspace_id = $2
                     AND m2.identifier = h.identifier
                ) ELSE NULL END AS first_at
       ) arr ON TRUE
      WHERE ($6 = 'all'
          OR ($6 = 'group' AND (h.has_author OR g.jid IS NOT NULL))
          OR ($6 = 'dm' AND NOT (h.has_author OR g.jid IS NOT NULL)))
        AND ${leadFilterSql(leadStatus)}
        AND ($8::text IS NULL
             OR ($8 = 'none' AND tm.lead_stage IS NULL)
             OR ($8 <> 'none' AND tm.lead_stage = $8))
        AND ($9::text IS NULL OR tm.lead_source = $9)
        AND ($10::text IS NULL OR EXISTS (
              SELECT 1 FROM whatsapp_thread_tags t
               WHERE t.whatsapp_number_id = $1 AND t.identifier = h.identifier AND t.tag = $10
            ))
        AND ($11::text IS NULL
             OR ($11 = 'with' AND COALESCE(os.opportunity_count, 0) > 0)
             OR ($11 = 'without' AND COALESCE(os.opportunity_count, 0) = 0))
        -- Toggle Em andamento/Perdidas (spec §2): 'em_andamento'/'perdido' somam as
        -- GANHAS sempre (paridade com o kanban). Filtro por 'ganho' segue exato.
        AND ($12::text IS NULL OR EXISTS (
              SELECT 1 FROM whatsapp_opportunities oflt
               WHERE oflt.whatsapp_number_id = $1 AND oflt.identifier = h.identifier
                 AND (oflt.status = $12
                      OR ($12 IN ('em_andamento', 'perdido') AND oflt.status = 'ganho'))
            ))
        AND ($13::text IS NULL OR EXISTS (
              SELECT 1 FROM whatsapp_opportunities oflt
               WHERE oflt.whatsapp_number_id = $1 AND oflt.identifier = h.identifier
                 AND oflt.is_qualified IS NOT DISTINCT FROM
                     (CASE $13 WHEN 'true' THEN TRUE WHEN 'false' THEN FALSE ELSE NULL END)
            ))
        AND ($14::bigint IS NULL OR EXISTS (
              SELECT 1 FROM whatsapp_opportunities oflt
              JOIN whatsapp_opportunity_tags oft ON oft.opportunity_id = oflt.id
               WHERE oflt.whatsapp_number_id = $1 AND oflt.identifier = h.identifier
                 AND oft.tag_id = $14
            ))
        AND ($15::text[] IS NULL OR opp_col.opp_board_column = ANY($15))
        AND ($16::timestamptz IS NULL OR arr.first_at >= $16)
        AND ($17::timestamptz IS NULL OR arr.first_at <= $17)
      ORDER BY h.last_match_at DESC
      LIMIT $7`,
    params);
  const results: SearchHit[] = rows.map(r => ({
    identifier: r.identifier, kind: r.is_group ? 'group' : 'dm', name: r.name ?? null,
    matchCount: r.match_count, lastMatchAt: r.last_match_at.toISOString(), snippet: r.snippet,
    leadStatus: deriveLeadStatus(r.is_lead),
    leadStage: r.lead_stage ?? null,
    leadTemperature: r.lead_temperature ?? null,
    leadSource: r.lead_source ?? null,
    disqualifyReason: r.disqualify_reason ?? null,
    tags: r.tags ?? [],
    opportunities: mapOpportunitySummary(r),
  }));
  return { results };
}
