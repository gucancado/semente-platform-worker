import type { Pool } from 'pg';
import { leadFilterSql, type LeadStatus } from './lead-filter.js';

export type Thread = { identifier: string; lastAt: string; lastText: string | null; count: number; kind: 'dm' | 'group'; name: string | null; leadStatus: 'lead' | 'not_lead' };
function encode(c: { lastAt: string; identifier: string }) { return Buffer.from(JSON.stringify(c)).toString('base64'); }
function decode(s: string): { lastAt: string; identifier: string } { return JSON.parse(Buffer.from(s, 'base64').toString()); }

export async function listThreads(pool: Pool, p: { workspaceId: string; numberId: number; limit: number; cursor?: string; kind?: 'dm' | 'group' | 'all'; leadStatus?: LeadStatus }) {
  const cur = p.cursor ? decode(p.cursor) : null;
  const kind = p.kind ?? 'all';
  const leadStatus = p.leadStatus ?? 'all';
  const { rows } = await pool.query(
    `WITH agg AS (
       SELECT m.identifier,
              MAX(m.created_at) AS last_at,
              COUNT(*)::int AS count,
              (ARRAY_AGG(m.text ORDER BY m.created_at DESC))[1] AS last_text,
              bool_or(m.author IS NOT NULL) AS has_author
         FROM messages m
        WHERE m.whatsapp_number_id = $1 AND m.workspace_id = $2
        GROUP BY m.identifier
     )
     SELECT a.identifier, a.last_at, a.count, a.last_text,
            (a.has_author OR g.jid IS NOT NULL) AS is_group,
            (tm.is_lead = FALSE) AS not_lead,
            CASE WHEN (a.has_author OR g.jid IS NOT NULL) THEN g.subject
                 ELSE (SELECT w.push_name FROM webhook_logs w
                        WHERE w.whatsapp_number_id = $1 AND w.identifier = a.identifier
                          AND w.push_name IS NOT NULL
                        ORDER BY w.created_at DESC LIMIT 1)
            END AS name
       FROM agg a
       LEFT JOIN whatsapp_groups g
         ON g.whatsapp_number_id = $1 AND g.jid = a.identifier
       LEFT JOIN whatsapp_thread_meta tm
         ON tm.whatsapp_number_id = $1 AND tm.identifier = a.identifier
      WHERE ($3::timestamptz IS NULL
          OR a.last_at < $3
          OR (a.last_at = $3 AND a.identifier > $4))
        AND ($6 = 'all'
          OR ($6 = 'group' AND (a.has_author OR g.jid IS NOT NULL))
          OR ($6 = 'dm' AND NOT (a.has_author OR g.jid IS NOT NULL)))
        AND ${leadFilterSql(leadStatus)}
      ORDER BY a.last_at DESC, a.identifier ASC
      LIMIT $5`,
    [p.numberId, p.workspaceId, cur?.lastAt ?? null, cur?.identifier ?? null, p.limit, kind]);
  const threads: Thread[] = rows.map(r => ({
    identifier: r.identifier, lastAt: r.last_at.toISOString(), lastText: r.last_text, count: r.count,
    kind: r.is_group ? 'group' : 'dm', name: r.name ?? null,
    leadStatus: r.not_lead ? 'not_lead' : 'lead',
  }));
  const last = threads.at(-1);
  const nextCursor = threads.length === p.limit && last ? encode({ lastAt: last.lastAt, identifier: last.identifier }) : null;
  return { threads, nextCursor };
}

export type Msg = { direction: string; text: string | null; agent: string | null; createdAt: string; author: string | null; authorName: string | null };
export async function listThreadMessages(pool: Pool, p: { numberId: number; identifier: string; limit: number; cursor?: string; since?: string; until?: string }) {
  const before = p.cursor ? Buffer.from(p.cursor, 'base64').toString() : null;
  const { rows } = await pool.query(
    `SELECT m.direction, m.text, m.agent, m.created_at, m.author,
            w.push_name AS author_name
       FROM messages m
       LEFT JOIN webhook_logs w
         ON w.evolution_event_id = m.evolution_event_id
        AND w.whatsapp_number_id = m.whatsapp_number_id
        AND m.direction = 'inbound'
      WHERE m.whatsapp_number_id = $1 AND m.identifier = $2
        AND ($3::timestamptz IS NULL OR m.created_at < $3)
        AND ($5::timestamptz IS NULL OR m.created_at >= $5)
        AND ($6::timestamptz IS NULL OR m.created_at <= $6)
      ORDER BY m.created_at DESC LIMIT $4`,
    [p.numberId, p.identifier, before, p.limit, p.since ?? null, p.until ?? null]);
  const messages: Msg[] = rows.map(r => ({ direction: r.direction, text: r.text, agent: r.agent, createdAt: r.created_at.toISOString(), author: r.author, authorName: r.author_name }));
  const lastMsg = messages.at(-1);
  const nextCursor = messages.length === p.limit && lastMsg ? Buffer.from(lastMsg.createdAt).toString('base64') : null;
  return { messages, nextCursor };
}

export type SearchHit = { identifier: string; kind: 'dm' | 'group'; name: string | null; matchCount: number; lastMatchAt: string; snippet: string; leadStatus: 'lead' | 'not_lead' };

export async function searchThreads(pool: Pool, p: { workspaceId: string; numberId: number; query: string; since?: string; until?: string; kind?: 'dm' | 'group' | 'all'; leadStatus?: LeadStatus; limit?: number }) {
  const kind = p.kind ?? 'all';
  const leadStatus = p.leadStatus ?? 'all';
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
            (tm.is_lead = FALSE) AS not_lead,
            CASE WHEN (h.has_author OR g.jid IS NOT NULL) THEN g.subject
                 ELSE (SELECT w.push_name FROM webhook_logs w
                        WHERE w.whatsapp_number_id = $1 AND w.identifier = h.identifier AND w.push_name IS NOT NULL
                        ORDER BY w.created_at DESC LIMIT 1) END AS name
       FROM hits h
       LEFT JOIN whatsapp_groups g ON g.whatsapp_number_id = $1 AND g.jid = h.identifier
       LEFT JOIN whatsapp_thread_meta tm ON tm.whatsapp_number_id = $1 AND tm.identifier = h.identifier
      WHERE ($6 = 'all'
          OR ($6 = 'group' AND (h.has_author OR g.jid IS NOT NULL))
          OR ($6 = 'dm' AND NOT (h.has_author OR g.jid IS NOT NULL)))
        AND ${leadFilterSql(leadStatus)}
      ORDER BY h.last_match_at DESC
      LIMIT $7`,
    [p.numberId, p.workspaceId, p.query, p.since ?? null, p.until ?? null, kind, p.limit ?? 30]);
  const results: SearchHit[] = rows.map(r => ({
    identifier: r.identifier, kind: r.is_group ? 'group' : 'dm', name: r.name ?? null,
    matchCount: r.match_count, lastMatchAt: r.last_match_at.toISOString(), snippet: r.snippet,
    leadStatus: r.not_lead ? 'not_lead' : 'lead',
  }));
  return { results };
}
