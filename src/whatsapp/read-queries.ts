import type { Pool } from 'pg';

export type Thread = { identifier: string; lastAt: string; lastText: string | null; count: number; kind: 'dm' | 'group'; name: string | null };
function encode(c: { lastAt: string; identifier: string }) { return Buffer.from(JSON.stringify(c)).toString('base64'); }
function decode(s: string): { lastAt: string; identifier: string } { return JSON.parse(Buffer.from(s, 'base64').toString()); }

export async function listThreads(pool: Pool, p: { workspaceId: string; numberId: number; limit: number; cursor?: string; kind?: 'dm' | 'group' | 'all' }) {
  const cur = p.cursor ? decode(p.cursor) : null;
  const kind = p.kind ?? 'all';
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
            CASE WHEN (a.has_author OR g.jid IS NOT NULL) THEN g.subject
                 ELSE (SELECT w.push_name FROM webhook_logs w
                        WHERE w.whatsapp_number_id = $1 AND w.identifier = a.identifier
                          AND w.push_name IS NOT NULL
                        ORDER BY w.created_at DESC LIMIT 1)
            END AS name
       FROM agg a
       LEFT JOIN whatsapp_groups g
         ON g.whatsapp_number_id = $1 AND g.jid = a.identifier
      WHERE ($3::timestamptz IS NULL
          OR a.last_at < $3
          OR (a.last_at = $3 AND a.identifier > $4))
        AND ($6 = 'all'
          OR ($6 = 'group' AND (a.has_author OR g.jid IS NOT NULL))
          OR ($6 = 'dm' AND NOT (a.has_author OR g.jid IS NOT NULL)))
      ORDER BY a.last_at DESC, a.identifier ASC
      LIMIT $5`,
    [p.numberId, p.workspaceId, cur?.lastAt ?? null, cur?.identifier ?? null, p.limit, kind]);
  const threads: Thread[] = rows.map(r => ({
    identifier: r.identifier, lastAt: r.last_at.toISOString(), lastText: r.last_text, count: r.count,
    kind: r.is_group ? 'group' : 'dm', name: r.name ?? null,
  }));
  const last = threads.at(-1);
  const nextCursor = threads.length === p.limit && last ? encode({ lastAt: last.lastAt, identifier: last.identifier }) : null;
  return { threads, nextCursor };
}

export type Msg = { direction: string; text: string | null; agent: string | null; createdAt: string; author: string | null; authorName: string | null };
export async function listThreadMessages(pool: Pool, p: { numberId: number; identifier: string; limit: number; cursor?: string }) {
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
      ORDER BY m.created_at DESC LIMIT $4`,
    [p.numberId, p.identifier, before, p.limit]);
  const messages: Msg[] = rows.map(r => ({ direction: r.direction, text: r.text, agent: r.agent, createdAt: r.created_at.toISOString(), author: r.author, authorName: r.author_name }));
  const lastMsg = messages.at(-1);
  const nextCursor = messages.length === p.limit && lastMsg ? Buffer.from(lastMsg.createdAt).toString('base64') : null;
  return { messages, nextCursor };
}
