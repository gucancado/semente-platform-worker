import type { Pool } from 'pg';
import { leadFilterSql, type LeadStatus } from './lead-filter.js';

export type Thread = {
  identifier: string;
  lastAt: string;
  lastText: string | null;
  count: number;
  kind: 'dm' | 'group';
  name: string | null;
  leadStatus: 'lead' | 'not_lead';
  leadStage: string | null;
  leadTemperature: string | null;
  leadSource: string | null;
  disqualifyReason: string | null;
  tags: string[];
  /** Present only when `includeFirstInboundText` was requested. Null if no inbound message exists. */
  firstInboundText?: string | null;
};
function encode(c: { lastAt: string; identifier: string }) { return Buffer.from(JSON.stringify(c)).toString('base64'); }
function decode(s: string): { lastAt: string; identifier: string } { return JSON.parse(Buffer.from(s, 'base64').toString()); }

export async function listThreads(pool: Pool, p: {
  workspaceId: string;
  numberId: number;
  limit: number;
  cursor?: string;
  kind?: 'dm' | 'group' | 'all';
  leadStatus?: LeadStatus;
  leadStage?: string;
  leadSource?: string;
  tag?: string;
  /** When true, adds `firstInboundText` to each thread (correlated subquery, opt-in). */
  includeFirstInboundText?: boolean;
}) {
  const cur = p.cursor ? decode(p.cursor) : null;
  const kind = p.kind ?? 'all';
  const leadStatus = p.leadStatus ?? 'all';
  const includeFirstInbound = p.includeFirstInboundText === true;

  // $1=numberId $2=workspaceId $3=cur.lastAt $4=cur.identifier $5=limit $6=kind
  // $7=leadStage $8=leadSource $9=tag
  const params: unknown[] = [
    p.numberId,
    p.workspaceId,
    cur?.lastAt ?? null,
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
            tm.lead_stage, tm.lead_temperature, tm.lead_source, tm.disqualify_reason,
            CASE WHEN (a.has_author OR g.jid IS NOT NULL) THEN g.subject
                 ELSE (SELECT w.push_name FROM webhook_logs w
                        WHERE w.whatsapp_number_id = $1 AND w.identifier = a.identifier
                          AND w.push_name IS NOT NULL
                        ORDER BY w.created_at DESC LIMIT 1)
            END AS name,
            COALESCE(
              (SELECT ARRAY_AGG(t.tag ORDER BY t.tag)
                 FROM whatsapp_thread_tags t
                WHERE t.whatsapp_number_id = $1 AND t.identifier = a.identifier),
              '{}'::text[]
            ) AS tags,
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
      WHERE ($3::timestamptz IS NULL
          OR a.last_at < $3
          OR (a.last_at = $3 AND a.identifier > $4))
        AND ($6 = 'all'
          OR ($6 = 'group' AND (a.has_author OR g.jid IS NOT NULL))
          OR ($6 = 'dm' AND NOT (a.has_author OR g.jid IS NOT NULL)))
        AND ${leadFilterSql(leadStatus)}
        AND ($7::text IS NULL OR tm.lead_stage = $7)
        AND ($8::text IS NULL OR tm.lead_source = $8)
        AND ($9::text IS NULL OR EXISTS (
              SELECT 1 FROM whatsapp_thread_tags t
               WHERE t.whatsapp_number_id = $1 AND t.identifier = a.identifier AND t.tag = $9
            ))
      ORDER BY a.last_at DESC, a.identifier ASC
      LIMIT $5`,
    params);
  const threads: Thread[] = rows.map(r => {
    const t: Thread = {
      identifier: r.identifier, lastAt: r.last_at.toISOString(), lastText: r.last_text, count: r.count,
      kind: r.is_group ? 'group' : 'dm', name: r.name ?? null,
      leadStatus: r.not_lead ? 'not_lead' : 'lead',
      leadStage: r.lead_stage ?? null,
      leadTemperature: r.lead_temperature ?? null,
      leadSource: r.lead_source ?? null,
      disqualifyReason: r.disqualify_reason ?? null,
      tags: r.tags ?? [],
    };
    if (includeFirstInbound) {
      t.firstInboundText = r.first_inbound_text ?? null;
    }
    return t;
  });
  const last = threads.at(-1);
  const nextCursor = threads.length === p.limit && last ? encode({ lastAt: last.lastAt, identifier: last.identifier }) : null;
  return { threads, nextCursor };
}

export type Msg = { direction: string; text: string | null; agent: string | null; createdAt: string; author: string | null; authorName: string | null };
export async function listThreadMessages(pool: Pool, p: { workspaceId: string; numberId: number; identifier: string; limit: number; cursor?: string; since?: string; until?: string }) {
  const before = p.cursor ? Buffer.from(p.cursor, 'base64').toString() : null;
  const { rows } = await pool.query(
    `SELECT m.direction, m.text, m.agent, m.created_at, m.author,
            w.push_name AS author_name
       FROM messages m
       LEFT JOIN webhook_logs w
         ON w.evolution_event_id = m.evolution_event_id
        AND w.whatsapp_number_id = m.whatsapp_number_id
        AND m.direction = 'inbound'
      WHERE m.whatsapp_number_id = $1 AND m.identifier = $2 AND m.workspace_id = $7
        AND ($3::timestamptz IS NULL OR m.created_at < $3)
        AND ($5::timestamptz IS NULL OR m.created_at >= $5)
        AND ($6::timestamptz IS NULL OR m.created_at <= $6)
      ORDER BY m.created_at DESC LIMIT $4`,
    [p.numberId, p.identifier, before, p.limit, p.since ?? null, p.until ?? null, p.workspaceId]);
  const messages: Msg[] = rows.map(r => ({ direction: r.direction, text: r.text, agent: r.agent, createdAt: r.created_at.toISOString(), author: r.author, authorName: r.author_name }));
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
  leadStatus: 'lead' | 'not_lead';
  leadStage: string | null;
  leadTemperature: string | null;
  leadSource: string | null;
  disqualifyReason: string | null;
  tags: string[];
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
}) {
  const kind = p.kind ?? 'all';
  const leadStatus = p.leadStatus ?? 'all';

  // $1=numberId $2=workspaceId $3=query $4=since $5=until $6=kind $7=limit
  // $8=leadStage $9=leadSource $10=tag
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
            (tm.is_lead = FALSE) AS not_lead,
            tm.lead_stage, tm.lead_temperature, tm.lead_source, tm.disqualify_reason,
            CASE WHEN (h.has_author OR g.jid IS NOT NULL) THEN g.subject
                 ELSE (SELECT w.push_name FROM webhook_logs w
                        WHERE w.whatsapp_number_id = $1 AND w.identifier = h.identifier AND w.push_name IS NOT NULL
                        ORDER BY w.created_at DESC LIMIT 1) END AS name,
            COALESCE(
              (SELECT ARRAY_AGG(t.tag ORDER BY t.tag)
                 FROM whatsapp_thread_tags t
                WHERE t.whatsapp_number_id = $1 AND t.identifier = h.identifier),
              '{}'::text[]
            ) AS tags
       FROM hits h
       LEFT JOIN whatsapp_groups g ON g.whatsapp_number_id = $1 AND g.jid = h.identifier
       LEFT JOIN whatsapp_thread_meta tm ON tm.whatsapp_number_id = $1 AND tm.identifier = h.identifier
      WHERE ($6 = 'all'
          OR ($6 = 'group' AND (h.has_author OR g.jid IS NOT NULL))
          OR ($6 = 'dm' AND NOT (h.has_author OR g.jid IS NOT NULL)))
        AND ${leadFilterSql(leadStatus)}
        AND ($8::text IS NULL OR tm.lead_stage = $8)
        AND ($9::text IS NULL OR tm.lead_source = $9)
        AND ($10::text IS NULL OR EXISTS (
              SELECT 1 FROM whatsapp_thread_tags t
               WHERE t.whatsapp_number_id = $1 AND t.identifier = h.identifier AND t.tag = $10
            ))
      ORDER BY h.last_match_at DESC
      LIMIT $7`,
    params);
  const results: SearchHit[] = rows.map(r => ({
    identifier: r.identifier, kind: r.is_group ? 'group' : 'dm', name: r.name ?? null,
    matchCount: r.match_count, lastMatchAt: r.last_match_at.toISOString(), snippet: r.snippet,
    leadStatus: r.not_lead ? 'not_lead' : 'lead',
    leadStage: r.lead_stage ?? null,
    leadTemperature: r.lead_temperature ?? null,
    leadSource: r.lead_source ?? null,
    disqualifyReason: r.disqualify_reason ?? null,
    tags: r.tags ?? [],
  }));
  return { results };
}
