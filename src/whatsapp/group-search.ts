import type { Pool } from 'pg';
import type { GroupScope } from './group-links.js';
import type { Msg } from './read-queries.js';

/**
 * Busca group-scoped + janela ancorada do contrato `group_v1`.
 *
 * O filtro de escopo é IDÊNTICO ao dos leitores (`listThreadMessages` no
 * escopo number, `listGroupMessagesByAgent` no agent) — é a mesma fronteira
 * de isolamento, não uma otimização. O JOIN de webhook_logs usa
 * `IS NOT DISTINCT FROM` nos dois escopos: NULL-safe pro agent (as duas
 * colunas são NULL) e equivalente a `=` no number (nunca são NULL lá).
 */
export function scopeWhere(scope: GroupScope, identifier: string): { sql: string; params: unknown[] } {
  return scope.kind === 'number'
    ? {
        sql: 'm.whatsapp_number_id = $1 AND m.workspace_id = $2 AND m.identifier = $3',
        params: [scope.numberId, scope.numberWorkspaceId, identifier],
      }
    : {
        sql: 'm.agent = $1 AND m.identifier = $2 AND m.whatsapp_number_id IS NULL',
        params: [scope.agent, identifier],
      };
}

/** Escapa `\`, `%` e `_` pro pattern do ILIKE (par com o `ESCAPE '\'` no SQL). */
export function escapeIlike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Recorte de ±(120/180) chars em volta do 1º match case-insensitive.
 * `messages.text` é TEXT sem teto (transcrição de áudio pode ser enorme) —
 * o payload da busca leva o recorte, nunca o texto integral.
 */
export function buildSnippet(text: string, q: string): string {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.length <= 300 ? text : `${text.slice(0, 300)}…`;
  const start = Math.max(0, idx - 120);
  const end = Math.min(text.length, idx + q.length + 180);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export type GroupSearchHit = {
  id: number;
  createdAt: string;
  direction: 'inbound' | 'outbound';
  author: string | null;
  authorName: string | null;
  snippet: string;
};

export async function searchGroupMessages(pool: Pool, p: {
  scope: GroupScope;
  identifier: string;
  q: string;
  limit: number;
}): Promise<{ hits: GroupSearchHit[]; truncated: boolean }> {
  const w = scopeWhere(p.scope, p.identifier);
  const n = w.params.length;
  // limit+1: uma linha a mais só pra saber se há resto — `hits.length === limit`
  // daria truncated:true falso quando o total é EXATAMENTE limit.
  const { rows } = await pool.query(
    `SELECT m.id, m.direction, m.text, m.created_at, m.author,
            w.push_name AS author_name
       FROM messages m
       LEFT JOIN webhook_logs w
         ON w.evolution_event_id = m.evolution_event_id
        AND w.whatsapp_number_id IS NOT DISTINCT FROM m.whatsapp_number_id
        AND m.direction = 'inbound'
      WHERE ${w.sql}
        AND m.text ILIKE '%' || $${n + 1} || '%' ESCAPE '\\'
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $${n + 2}`,
    [...w.params, escapeIlike(p.q), p.limit + 1],
  );
  const truncated = rows.length > p.limit;
  const hits: GroupSearchHit[] = rows.slice(0, p.limit).map((r: any) => ({
    id: Number(r.id),
    createdAt: r.created_at.toISOString(),
    direction: r.direction,
    author: r.author,
    authorName: r.author_name,
    snippet: buildSnippet(r.text ?? '', p.q),
  }));
  return { hits, truncated };
}

/** SELECT compartilhado da janela — mesmo shape `Msg` dos leitores. */
const MSG_SELECT = `SELECT m.id, m.direction, m.text, m.agent, m.created_at, m.author,
        m.kind, m.transcription_status, m.media_duration_s, m.media_key,
        w.push_name AS author_name
   FROM messages m
   LEFT JOIN webhook_logs w
     ON w.evolution_event_id = m.evolution_event_id
    AND w.whatsapp_number_id IS NOT DISTINCT FROM m.whatsapp_number_id
    AND m.direction = 'inbound'`;

function mapMsg(r: any): Msg {
  return {
    id: Number(r.id),
    direction: r.direction,
    text: r.text,
    agent: r.agent,
    createdAt: r.created_at.toISOString(),
    author: r.author,
    authorName: r.author_name,
    kind: r.kind,
    transcriptionStatus: r.transcription_status,
    mediaDurationS: r.media_duration_s,
    hasMedia: r.media_key != null,
  };
}

/**
 * Resolve a mensagem-âncora POR ID **dentro do escopo do grupo** — id de outra
 * conversa não resolve (a rota devolve 404 sem revelar existência). `id` é
 * string de dígitos validada na rota (BIGSERIAL; sem Number() no WHERE).
 */
export async function resolveAnchor(pool: Pool, p: {
  scope: GroupScope; identifier: string; id: string;
}): Promise<{ id: string; createdAt: Date } | null> {
  const w = scopeWhere(p.scope, p.identifier);
  const n = w.params.length;
  const { rows } = await pool.query(
    `SELECT m.id, m.created_at FROM messages m WHERE ${w.sql} AND m.id = $${n + 1}::bigint LIMIT 1`,
    [...w.params, p.id],
  );
  if (rows.length === 0) return null;
  return { id: String(rows[0].id), createdAt: rows[0].created_at };
}

/**
 * Janela de mensagens em volta da âncora, por TUPLA (created_at, id).
 * Metade antiga (<=, inclui a âncora) + metade nova (>) — sem overlap por
 * construção, então o merge é concat (novas revertidas primeiro) e o
 * resultado sai DESC como os leitores. `nextCursor` segue a convenção
 * existente (base64 do createdAt) — limitação timestamp-only pré-existente
 * do contrato; a página não pagina hoje.
 */
export async function listMessagesAround(pool: Pool, p: {
  scope: GroupScope; identifier: string;
  anchor: { id: string; createdAt: Date };
  half?: number;
}): Promise<{ messages: Msg[]; nextCursor: string | null }> {
  const half = p.half ?? 25;
  const w = scopeWhere(p.scope, p.identifier);
  const n = w.params.length;
  const params = [...w.params, p.anchor.createdAt, p.anchor.id, half];
  const [older, newer] = await Promise.all([
    pool.query(
      `${MSG_SELECT} WHERE ${w.sql} AND (m.created_at, m.id) <= ($${n + 1}::timestamptz, $${n + 2}::bigint)
        ORDER BY m.created_at DESC, m.id DESC LIMIT $${n + 3}`, params),
    pool.query(
      `${MSG_SELECT} WHERE ${w.sql} AND (m.created_at, m.id) > ($${n + 1}::timestamptz, $${n + 2}::bigint)
        ORDER BY m.created_at ASC, m.id ASC LIMIT $${n + 3}`, params),
  ]);
  const olderMsgs = older.rows.map(mapMsg);            // já DESC
  const newerMsgs = newer.rows.map(mapMsg).reverse();  // ASC → DESC
  const messages = [...newerMsgs, ...olderMsgs];
  const last = olderMsgs.at(-1);
  const nextCursor = olderMsgs.length === half && last ? Buffer.from(last.createdAt).toString('base64') : null;
  return { messages, nextCursor };
}
