/**
 * src/whatsapp/board.ts
 *
 * CRM WhatsApp v3 — Fase C, Task C1: projeção do KANBAN (spec §5/§10). Endpoint
 * `GET /whatsapp/board` (rota em board-routes.ts) devolve as 5 colunas
 * (novas_conversas·interessados·negociacoes·ganhos·perdas) com cards + counts.
 *
 * FONTE ÚNICA da regra de coluna é o kernel `boardColumn` (opportunity-core.ts).
 * A projeção SQL (CASE `board_column` no BOARD_OPPS_CTE) DEVE espelhar o kernel;
 * `boardColumnSqlMirror` abaixo é uma transcrição TS EXATA desse CASE, provada
 * idêntica ao kernel por teste de paridade (tests/board.test.ts) — e o CASE real
 * é provado por tests/whatsapp/board.db.test.ts (fixtures nas 5 colunas).
 *
 * Entram no board só opps de threads DM com is_lead IS DISTINCT FROM FALSE (spec
 * §5): DM-only pelo detector CANÔNICO (NOT EXISTS grupo pelo jid + NOT EXISTS
 * mensagem com author — mesmo padrão de stats.ts triageQueueQuery/opportunity-
 * pipeline). `contactName` reusa a derivação de push_name inbound do listThreads
 * (read-queries.ts — push_name de evento fromMe é o dono do número, não o
 * contato). `lastMessageAt` = MAX(messages.created_at) do par (LATERAL).
 *
 * Ordenação por última atividade da conversa DESC: (lastMessageAt DESC NULLS
 * LAST, opp_id DESC). Cursor opaco base64url de [lastMessageAt|null, oppId] —
 * paginação best-effort por coluna (a atividade muda entre páginas; o cliente
 * dedupe por opp_id).
 *
 * Módulo PURO no sentido de imports: só tipos de 'pg' + opportunity-core.ts
 * (kernel/tipos, puro) + loss-reasons.ts (constante CASCADE_LOSS_REASON, puro) —
 * nenhum importa config.js/env de servidor, então tests/board.test.ts roda local
 * sem DATABASE_URL (mesmo molde de opportunity-pipeline.ts / auto-loss.ts).
 */
import type { Pool } from 'pg';
import {
  boardColumn,
  qualificationLabel,
  type BoardColumn,
  type OppQualification,
  type OppStatus,
} from './opportunity-core.js';
import { CASCADE_LOSS_REASON } from './loss-reasons.js';

/** Ordem canônica das colunas do board (spec §5). Também a ordem de emissão. */
export const BOARD_COLUMNS: readonly BoardColumn[] = [
  'novas_conversas',
  'interessados',
  'negociacoes',
  'ganhos',
  'perdas',
];

const BOARD_COLUMN_SET = new Set<string>(BOARD_COLUMNS);

/** Type guard de coluna válida (usado na validação de `?column=` da rota). */
export function isBoardColumn(value: unknown): value is BoardColumn {
  return typeof value === 'string' && BOARD_COLUMN_SET.has(value);
}

export const DEFAULT_LIMIT_PER_COLUMN = 30;
export const MAX_LIMIT_PER_COLUMN = 100;

export interface BoardCard {
  opportunity: {
    id: number;
    title: string | null;
    status: OppStatus;
    isQualified: boolean | null;
    lossReason: string | null;
    qualification: OppQualification;
    tags: { id: number; name: string; color: string }[];
  };
  identifier: string;
  contactName: string | null;
  /** ISO (ms) da última mensagem da conversa (MAX), ou null se o par não tem mensagem. */
  lastMessageAt: string | null;
}

export interface BoardColumnResult {
  cards: BoardCard[];
  nextCursor: string | null;
  /** COUNT total da coluna, INDEPENDENTE do limit (spec §10). */
  total: number;
}

export type BoardColumns = Record<BoardColumn, BoardColumnResult>;

export interface BoardCursor {
  lastMessageAt: string | null;
  oppId: number;
}

// ── Cursor opaco ─────────────────────────────────────────────────────────────
// base64url de [lastMessageAt|null, oppId]. lastMessageAt é ISO ou null (cauda
// NULLS LAST da ordenação). Molde do encodeOpportunityCursor (opportunities.ts).

export function encodeBoardCursor(lastMessageAt: string | null, oppId: number): string {
  return Buffer.from(JSON.stringify([lastMessageAt, oppId]), 'utf8').toString('base64url');
}

export function decodeBoardCursor(cursor: string): BoardCursor | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [lastAt, id] = value;
    if (lastAt !== null && typeof lastAt !== 'string') return null;
    if (lastAt !== null && Number.isNaN(Date.parse(lastAt))) return null;
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) return null;
    return { lastMessageAt: lastAt, oppId: Number(id) };
  } catch {
    return null;
  }
}

// ── Espelho TS do CASE `board_column` da SQL (paridade com o kernel) ──────────
/**
 * Transcrição TS EXATA do CASE `board_column` do BOARD_OPPS_CTE, na MESMA ordem
 * de WHENs e com semântica SQL de três-valores (`x = y` é não-verdadeiro quando x
 * é NULL → cai pro próximo WHEN). Existe só pro teste de paridade provar que a
 * projeção SQL não divergiu do kernel `boardColumn` (opportunity-core.ts) — este é
 * a FONTE da regra. DEVE permanecer alinhada ao CASE; o .db.test.ts valida o CASE
 * real contra Postgres.
 */
export function boardColumnSqlMirror(
  isLead: boolean | null,
  status: OppStatus,
  isQualified: boolean | null,
  lossReason: string | null,
): BoardColumn | null {
  // `col = val` em SQL: NULL (não-true) quando col é NULL → o WHEN é pulado.
  const sqlEq = <T>(col: T | null, val: T): boolean => col !== null && col === val;
  if (sqlEq(isLead, false)) return null;
  if (sqlEq(status, 'ganho')) return 'ganhos';
  if (sqlEq(status, 'perdido')) {
    // SQL: loss_reason IS DISTINCT FROM 'nao_lead' → TRUE quando NULL ou != 'nao_lead'.
    return lossReason === CASCADE_LOSS_REASON ? null : 'perdas';
  }
  if (isLead === null) return 'novas_conversas';
  if (sqlEq(isLead, true) && isQualified === null) return 'interessados';
  if (sqlEq(isLead, true) && sqlEq(isQualified, true)) return 'negociacoes';
  return null;
}

// ── Query ────────────────────────────────────────────────────────────────────
// $1 = numberId, $2 = workspaceId. board_column mirrorado em boardColumnSqlMirror.
// Filtro DM-only + is_lead ≠ FALSE espelha stats.ts/opportunity-pipeline (canônico).
const BOARD_OPPS_CTE = `
board_opps AS (
  SELECT o.id AS opp_id, o.identifier, o.title, o.status, o.is_qualified, o.loss_reason,
         date_trunc('milliseconds', last.max_at) AS la,
         last.max_at AS last_at_raw,
         CASE
           WHEN tm.is_lead = FALSE THEN NULL
           WHEN o.status = 'ganho' THEN 'ganhos'
           WHEN o.status = 'perdido' THEN
             CASE WHEN o.loss_reason IS DISTINCT FROM '${CASCADE_LOSS_REASON}' THEN 'perdas' ELSE NULL END
           WHEN tm.is_lead IS NULL THEN 'novas_conversas'
           WHEN tm.is_lead = TRUE AND o.is_qualified IS NULL THEN 'interessados'
           WHEN tm.is_lead = TRUE AND o.is_qualified = TRUE THEN 'negociacoes'
           ELSE NULL
         END AS board_column,
         -- contactName: push_name de evento fromMe é o dono do número, não o contato —
         -- só vale o push_name de eventos com mensagem inbound correspondente (read-queries.ts).
         (SELECT w.push_name FROM webhook_logs w
            JOIN messages mi ON mi.evolution_event_id = w.evolution_event_id
                            AND mi.whatsapp_number_id = w.whatsapp_number_id
           WHERE w.whatsapp_number_id = $1 AND w.identifier = o.identifier
             AND w.push_name IS NOT NULL AND mi.direction = 'inbound'
           ORDER BY w.created_at DESC LIMIT 1) AS contact_name,
         COALESCE(
           (SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color)
                             ORDER BY t.name, t.id)
              FROM whatsapp_opportunity_tags ot JOIN whatsapp_tags t ON t.id = ot.tag_id
             WHERE ot.opportunity_id = o.id),
           '[]'::jsonb) AS tags
    FROM whatsapp_opportunities o
    LEFT JOIN whatsapp_thread_meta tm
      ON tm.whatsapp_number_id = o.whatsapp_number_id AND tm.identifier = o.identifier
    LEFT JOIN LATERAL (
      SELECT MAX(m.created_at) AS max_at
        FROM messages m
       WHERE m.whatsapp_number_id = o.whatsapp_number_id AND m.identifier = o.identifier
    ) last ON TRUE
   WHERE o.whatsapp_number_id = $1 AND o.workspace_id = $2
     AND (tm.is_lead IS DISTINCT FROM FALSE)
     AND NOT EXISTS (
       SELECT 1 FROM whatsapp_groups g
        WHERE g.whatsapp_number_id = o.whatsapp_number_id AND g.jid = o.identifier
     )
     AND NOT EXISTS (
       SELECT 1 FROM messages m2
        WHERE m2.whatsapp_number_id = o.whatsapp_number_id AND m2.identifier = o.identifier
          AND m2.author IS NOT NULL
     )
)`;

const isoOrNull = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(v as any).toISOString();

function mapBoardCard(r: any): BoardCard {
  const isQualified = r.is_qualified === undefined ? null : r.is_qualified;
  return {
    opportunity: {
      id: Number(r.opp_id),
      title: r.title ?? null,
      status: r.status,
      isQualified,
      lossReason: r.loss_reason ?? null,
      qualification: qualificationLabel(isQualified),
      tags: Array.isArray(r.tags)
        ? r.tags.map((t: any) => ({ id: Number(t.id), name: t.name, color: t.color }))
        : [],
    },
    identifier: r.identifier,
    contactName: r.contact_name ?? null,
    lastMessageAt: isoOrNull(r.last_at_raw),
  };
}

/**
 * Projeta o board de um número. Duas modalidades (spec §5/§10):
 *  - SEM `column`: primeira página de TODAS as 5 colunas (limit cada), via
 *    ROW_NUMBER particionado por coluna.
 *  - COM `column` (+ `cursor` opcional): só aquela coluna (carregar mais), com o
 *    predicado de cursor sobre a mesma ordenação (NULLS LAST).
 * As 5 chaves SEMPRE presentes (coluna sem cards = {cards:[], nextCursor:null,
 * total:N}); `total` por coluna vem de um COUNT independente do limit.
 */
export async function getBoard(pool: Pool, p: {
  workspaceId: string;
  numberId: number;
  limitPerColumn: number;
  column?: BoardColumn;
  cursor?: BoardCursor;
}): Promise<{ columns: BoardColumns }> {
  const cursorPresent = p.cursor !== undefined;

  const [countRes, cardRes] = await Promise.all([
    // Totais por coluna — independentes do limit e do `column`/cursor (spec §10).
    pool.query(
      `WITH ${BOARD_OPPS_CTE}
       SELECT board_column, COUNT(*)::int AS total
         FROM board_opps
        WHERE board_column IS NOT NULL
        GROUP BY board_column`,
      [p.numberId, p.workspaceId],
    ),
    // Cards: ROW_NUMBER por coluna (multi) OU filtrado a uma coluna + cursor (single).
    // $3=column|null $4=cursor.lastMessageAt|null $5=cursor.oppId|null $6=cursorPresent $7=limit+1
    pool.query(
      `WITH ${BOARD_OPPS_CTE},
       ranked AS (
         SELECT bo.*,
                ROW_NUMBER() OVER (
                  PARTITION BY board_column
                  ORDER BY la DESC NULLS LAST, opp_id DESC
                ) AS rn
           FROM board_opps bo
          WHERE board_column IS NOT NULL
            AND ($3::text IS NULL OR board_column = $3)
            AND (NOT $6::boolean OR (
                  ($4::timestamptz IS NOT NULL AND (
                     la IS NULL OR la < $4 OR (la = $4 AND opp_id < $5)))
                  OR ($4::timestamptz IS NULL AND la IS NULL AND opp_id < $5)
                ))
       )
       SELECT opp_id, identifier, title, status, is_qualified, loss_reason, board_column,
              contact_name, tags, last_at_raw
         FROM ranked
        WHERE rn <= $7
        ORDER BY board_column, la DESC NULLS LAST, opp_id DESC`,
      [
        p.numberId, p.workspaceId, p.column ?? null,
        p.cursor?.lastMessageAt ?? null, p.cursor?.oppId ?? null,
        cursorPresent, p.limitPerColumn + 1,
      ],
    ),
  ]);

  const totals = new Map<string, number>();
  for (const r of countRes.rows) totals.set(String(r.board_column), Number(r.total));

  const grouped = new Map<string, any[]>();
  for (const r of cardRes.rows) {
    const col = String(r.board_column);
    const bucket = grouped.get(col);
    if (bucket) bucket.push(r);
    else grouped.set(col, [r]);
  }

  const columns = {} as BoardColumns;
  for (const col of BOARD_COLUMNS) {
    const rows = grouped.get(col) ?? [];
    const hasMore = rows.length > p.limitPerColumn;
    const cards = rows.slice(0, p.limitPerColumn).map(mapBoardCard);
    const last = cards.at(-1);
    const nextCursor = hasMore && last
      ? encodeBoardCursor(last.lastMessageAt, last.opportunity.id)
      : null;
    columns[col] = { cards, nextCursor, total: totals.get(col) ?? 0 };
  }

  return { columns };
}
