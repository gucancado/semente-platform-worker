import type { Pool, PoolClient } from 'pg';
import {
  applyOppPatch,
  type OppPatch,
  type OppQualification,
  type OppStatus,
} from './opportunity-core.js';

export interface OpportunityTag { id: number; name: string; color: string }
export interface Opportunity {
  id: number;
  identifier: string;
  title: string | null;
  status: OppStatus;
  qualification: OppQualification;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  createdBy: string | null;
  tags: OpportunityTag[];
}

export interface OpportunityEvent {
  id: number;
  field: 'created' | 'status' | 'qualification' | 'title' | 'tag_added' | 'tag_removed';
  oldValue: string | null;
  newValue: string | null;
  changedBy: string | null;
  changedAt: string;
}

type ScopedOpportunity = Opportunity & { numberId: number; workspaceId: string };
const iso = (value: any): string => value?.toISOString?.() ?? value;
const mapTag = (r: any): OpportunityTag => ({ id: Number(r.id), name: r.name, color: r.color });
const mapOpportunity = (r: any): Opportunity => ({
  id: Number(r.id),
  identifier: r.identifier, title: r.title, status: r.status, qualification: r.qualification,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  closedAt: r.closed_at ? iso(r.closed_at) : null, createdBy: r.created_by,
  tags: Array.isArray(r.tags) ? r.tags.map(mapTag) : [],
});
const mapScopedOpportunity = (r: any): ScopedOpportunity => ({
  ...mapOpportunity(r),
  numberId: Number(r.whatsapp_number_id),
  workspaceId: r.workspace_id,
});
const withoutScope = ({ numberId: _numberId, workspaceId: _workspaceId, ...opportunity }: ScopedOpportunity): Opportunity => opportunity;

const OPP_SELECT = `SELECT o.*,
  COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name, t.id)
    FROM whatsapp_opportunity_tags ot JOIN whatsapp_tags t ON t.id = ot.tag_id
    WHERE ot.opportunity_id = o.id), '[]'::json) AS tags
  FROM whatsapp_opportunities o`;

export function encodeOpportunityCursor(createdAt: string, id: number): string {
  return Buffer.from(JSON.stringify([createdAt, id]), 'utf8').toString('base64url');
}

export function decodeOpportunityCursor(cursor: string): { createdAt: string; id: number } | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string'
      || !Number.isSafeInteger(Number(value[1])) || Number(value[1]) <= 0) return null;
    if (Number.isNaN(Date.parse(value[0]))) return null;
    return { createdAt: value[0], id: Number(value[1]) };
  } catch { return null; }
}

export async function listOpportunities(pool: Pool, p: {
  numberId: number; workspaceId: string; status?: OppStatus; qualification?: OppQualification;
  tagId?: number; identifier?: string; limit: number; cursor?: { createdAt: string; id: number };
}): Promise<{ opportunities: Opportunity[]; nextCursor: string | null }> {
  const values: unknown[] = [p.numberId, p.workspaceId];
  const where = ['o.whatsapp_number_id = $1', 'o.workspace_id = $2'];
  const add = (sql: string, value: unknown) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
  if (p.status) add('o.status = ?', p.status);
  if (p.qualification) add('o.qualification = ?', p.qualification);
  if (p.identifier) add('o.identifier = ?', p.identifier);
  if (p.tagId !== undefined) add(`EXISTS (SELECT 1 FROM whatsapp_opportunity_tags f WHERE f.opportunity_id=o.id AND f.tag_id=?)`, p.tagId);
  if (p.cursor) {
    values.push(p.cursor.createdAt, p.cursor.id);
    where.push(`(date_trunc('milliseconds', o.created_at), o.id) < ($${values.length - 1}::timestamptz, $${values.length}::bigint)`);
  }
  values.push(p.limit + 1);
  const { rows } = await pool.query(`${OPP_SELECT} WHERE ${where.join(' AND ')}
    ORDER BY date_trunc('milliseconds', o.created_at) DESC, o.id DESC LIMIT $${values.length}`, values);
  const mapped = rows.map(mapOpportunity);
  const hasMore = mapped.length > p.limit;
  const opportunities = mapped.slice(0, p.limit);
  const last = opportunities.at(-1);
  return { opportunities, nextCursor: hasMore && last ? encodeOpportunityCursor(last.createdAt, last.id) : null };
}

export async function getOpportunity(pool: Pool, id: number): Promise<ScopedOpportunity | null> {
  const { rows } = await pool.query(`${OPP_SELECT} WHERE o.id = $1`, [id]);
  return rows[0] ? mapScopedOpportunity(rows[0]) : null;
}

export async function conversationExists(pool: Pool, p: { numberId: number; workspaceId: string; identifier: string }): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM messages WHERE whatsapp_number_id=$1 AND workspace_id=$2 AND identifier=$3
       UNION
       SELECT 1 FROM whatsapp_thread_meta WHERE whatsapp_number_id=$1 AND identifier=$3
     ) AS exists`,
    [p.numberId, p.workspaceId, p.identifier],
  );
  return rows[0]?.exists === true;
}

async function insertEvent(client: Pick<PoolClient, 'query'>, p: {
  opportunityId: number; field: string; oldValue: string | null; newValue: string | null; changedBy: string;
}) {
  await client.query(`INSERT INTO whatsapp_opportunity_events
    (opportunity_id, field, old_value, new_value, changed_by) VALUES ($1,$2,$3,$4,$5)`,
  [p.opportunityId, p.field, p.oldValue, p.newValue, p.changedBy]);
}

export async function createOpportunity(pool: Pool, p: {
  numberId: number; workspaceId: string; identifier: string; title?: string | null;
  qualification?: OppQualification; tagIds?: number[]; createdBy: string;
}): Promise<Opportunity | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (p.tagIds?.length) {
      const tags = await client.query(`SELECT id FROM whatsapp_tags WHERE workspace_id=$1 AND id=ANY($2::bigint[])`, [p.workspaceId, p.tagIds]);
      if (tags.rows.length !== new Set(p.tagIds).size) { await client.query('ROLLBACK'); return null; }
    }
    const { rows } = await client.query(`INSERT INTO whatsapp_opportunities
      (whatsapp_number_id, workspace_id, identifier, title, status, qualification, created_by)
      VALUES ($1,$2,$3,$4,'em_andamento',$5,$6) RETURNING id`,
    [p.numberId, p.workspaceId, p.identifier, p.title ?? null, p.qualification ?? 'indefinido', p.createdBy]);
    const id = Number(rows[0].id);
    await insertEvent(client, { opportunityId: id, field: 'created', oldValue: null, newValue: null, changedBy: p.createdBy });
    for (const tagId of new Set(p.tagIds ?? [])) {
      await client.query(`INSERT INTO whatsapp_opportunity_tags (opportunity_id, tag_id) VALUES ($1,$2)`, [id, tagId]);
    }
    await client.query('COMMIT');
    const created = await getOpportunity(pool, id);
    return created ? withoutScope(created) : null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

export async function patchOpportunity(pool: Pool, current: ScopedOpportunity, patch: OppPatch, changedBy: string): Promise<Opportunity> {
  const transition = applyOppPatch(current, patch);
  if (transition.events.length === 0) return current;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const values: unknown[] = [current.id];
    const set = transition.events.map(event => {
      values.push(transition.next[event.field as 'status' | 'qualification' | 'title']);
      return `${event.field}=$${values.length}`;
    });
    if (transition.closedAtAction === 'set_now') set.push('closed_at=NOW()');
    if (transition.closedAtAction === 'clear') set.push('closed_at=NULL');
    set.push('updated_at=NOW()');
    const { rows } = await client.query(`UPDATE whatsapp_opportunities SET
      ${set.join(', ')}
      WHERE id=$1 RETURNING id`, values);
    if (!rows[0]) throw new Error('opportunity disappeared during patch');
    for (const event of transition.events) {
      await insertEvent(client, { opportunityId: current.id, field: event.field, oldValue: event.oldValue, newValue: event.newValue, changedBy });
    }
    await client.query('COMMIT');
    const updated = await getOpportunity(pool, current.id);
    if (!updated) throw new Error('opportunity disappeared after patch');
    return withoutScope(updated);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

export async function deleteOpportunity(pool: Pool, id: number): Promise<void> {
  await pool.query(`DELETE FROM whatsapp_opportunities WHERE id=$1`, [id]);
}

export async function listOpportunityEvents(pool: Pool, id: number): Promise<OpportunityEvent[]> {
  const { rows } = await pool.query(`SELECT id, field, old_value, new_value, changed_by, changed_at
    FROM whatsapp_opportunity_events WHERE opportunity_id=$1 ORDER BY changed_at ASC, id ASC`, [id]);
  return rows.map((r: any) => ({ id: Number(r.id), field: r.field, oldValue: r.old_value,
    newValue: r.new_value, changedBy: r.changed_by, changedAt: iso(r.changed_at) }));
}

export async function changeOpportunityTag(pool: Pool, p: {
  opportunityId: number; workspaceId: string; tagId: number; changedBy: string; action: 'add' | 'remove';
}): Promise<{ found: boolean; changed: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tagResult = await client.query(`SELECT name FROM whatsapp_tags WHERE id=$1 AND workspace_id=$2`, [p.tagId, p.workspaceId]);
    if (!tagResult.rows[0]) { await client.query('ROLLBACK'); return { found: false, changed: false }; }
    const result = p.action === 'add'
      ? await client.query(`INSERT INTO whatsapp_opportunity_tags (opportunity_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING tag_id`, [p.opportunityId, p.tagId])
      : await client.query(`DELETE FROM whatsapp_opportunity_tags WHERE opportunity_id=$1 AND tag_id=$2 RETURNING tag_id`, [p.opportunityId, p.tagId]);
    const changed = (result.rowCount ?? 0) > 0;
    if (changed) await insertEvent(client, { opportunityId: p.opportunityId,
      field: p.action === 'add' ? 'tag_added' : 'tag_removed', oldValue: null,
      newValue: tagResult.rows[0].name, changedBy: p.changedBy });
    await client.query('COMMIT');
    return { found: true, changed };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}
