import type { Pool } from 'pg';

export type Thread = { identifier: string; lastAt: string; lastText: string | null; count: number };
function encode(c: { lastAt: string; identifier: string }) { return Buffer.from(JSON.stringify(c)).toString('base64'); }
function decode(s: string): { lastAt: string; identifier: string } { return JSON.parse(Buffer.from(s, 'base64').toString()); }

export async function listThreads(pool: Pool, p: { workspaceId: string; numberId: number; limit: number; cursor?: string }) {
  const cur = p.cursor ? decode(p.cursor) : null;
  const { rows } = await pool.query(
    `SELECT identifier, MAX(created_at) AS last_at, COUNT(*)::int AS count,
            (ARRAY_AGG(text ORDER BY created_at DESC))[1] AS last_text
       FROM messages
      WHERE whatsapp_number_id = $1 AND workspace_id = $2
      GROUP BY identifier
      HAVING ($3::timestamptz IS NULL OR (MAX(created_at), identifier) < ($3, $4))
      ORDER BY last_at DESC, identifier ASC
      LIMIT $5`,
    [p.numberId, p.workspaceId, cur?.lastAt ?? null, cur?.identifier ?? null, p.limit]);
  const threads: Thread[] = rows.map(r => ({ identifier: r.identifier, lastAt: r.last_at.toISOString(), lastText: r.last_text, count: r.count }));
  const last = threads.at(-1);
  const nextCursor = threads.length === p.limit && last ? encode({ lastAt: last.lastAt, identifier: last.identifier }) : null;
  return { threads, nextCursor };
}

export type Msg = { direction: string; text: string | null; agent: string | null; createdAt: string };
export async function listThreadMessages(pool: Pool, p: { numberId: number; identifier: string; limit: number; cursor?: string }) {
  const before = p.cursor ? Buffer.from(p.cursor, 'base64').toString() : null;
  const { rows } = await pool.query(
    `SELECT direction, text, agent, created_at FROM messages
      WHERE whatsapp_number_id = $1 AND identifier = $2
        AND ($3::timestamptz IS NULL OR created_at < $3)
      ORDER BY created_at DESC LIMIT $4`,
    [p.numberId, p.identifier, before, p.limit]);
  const messages: Msg[] = rows.map(r => ({ direction: r.direction, text: r.text, agent: r.agent, createdAt: r.created_at.toISOString() }));
  const lastMsg = messages.at(-1);
  const nextCursor = messages.length === p.limit && lastMsg ? Buffer.from(lastMsg.createdAt).toString('base64') : null;
  return { messages, nextCursor };
}
