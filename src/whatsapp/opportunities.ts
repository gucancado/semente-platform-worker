import type { Pool, PoolClient } from 'pg';
import {
  applyOppPatch,
  applyOppPatchV3,
  OppInvariantError,
  qualificationLabel,
  type OppPatch,
  type OppPatchV3,
  type OppQualification,
  type OppStateV3,
  type OppStatus,
} from './opportunity-core.js';
import { withConversationLock } from './conversation-lock.js';

export interface OpportunityTag { id: number; name: string; color: string }
export interface Opportunity {
  id: number;
  identifier: string;
  title: string | null;
  status: OppStatus;
  // v3: is_qualified é a fonte da verdade (NULL=indefinido/TRUE=qualificado/FALSE=desqualificado);
  // qualification continua exposta (derivada) até a Fase D remover a coluna legada.
  isQualified: boolean | null;
  lossReason: string | null;
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
export const mapOpportunity = (r: any): Opportunity => ({
  id: Number(r.id),
  identifier: r.identifier, title: r.title, status: r.status,
  isQualified: r.is_qualified === undefined ? null : r.is_qualified,
  lossReason: r.loss_reason ?? null,
  // Deriva de is_qualified quando a coluna está presente (inclui NULL→indefinido);
  // só cai na coluna legada `qualification` se is_qualified nem veio no SELECT.
  qualification: r.is_qualified !== undefined ? qualificationLabel(r.is_qualified) : r.qualification,
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

// SELECT o.* já traz as colunas v3 (is_qualified, loss_reason) desde a migration 051.
const OPP_SELECT = `SELECT o.*,
  COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name, t.id)
    FROM whatsapp_opportunity_tags ot JOIN whatsapp_tags t ON t.id = ot.tag_id
    WHERE ot.opportunity_id = o.id), '[]'::json) AS tags
  FROM whatsapp_opportunities o`;

/**
 * Resolve o filtro tri-state de qualificação a partir dos dois aliases aceitos:
 * `isQualified` (v3, boolean|null) tem precedência; `qualification` (legado, string)
 * é convertido. Retorna `undefined` (sem filtro), `null` (IS NULL / indefinido) ou o boolean.
 */
export function resolveIsQualifiedFilter(p: {
  isQualified?: boolean | null;
  qualification?: string;
}): boolean | null | undefined {
  if (p.isQualified !== undefined) return p.isQualified;
  switch (p.qualification) {
    case 'qualificado': return true;
    case 'desqualificado': return false;
    case 'indefinido': return null;
    default: return undefined;
  }
}

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
  numberId: number; workspaceId: string; status?: OppStatus;
  isQualified?: boolean | null; qualification?: OppQualification;
  tagId?: number; identifier?: string; limit: number; cursor?: { createdAt: string; id: number };
}): Promise<{ opportunities: Opportunity[]; nextCursor: string | null }> {
  const values: unknown[] = [p.numberId, p.workspaceId];
  const where = ['o.whatsapp_number_id = $1', 'o.workspace_id = $2'];
  const add = (sql: string, value: unknown) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
  if (p.status) add('o.status = ?', p.status);
  // Filtro tri-state por is_qualified (fonte v3), com `qualification` string como alias.
  const isQ = resolveIsQualifiedFilter(p);
  if (isQ === null) where.push('o.is_qualified IS NULL');
  else if (isQ !== undefined) add('o.is_qualified = ?', isQ);
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
    const tagNames = new Map<number, string>();
    if (p.tagIds?.length) {
      const tags = await client.query(`SELECT id, name FROM whatsapp_tags WHERE workspace_id=$1 AND id=ANY($2::bigint[])`, [p.workspaceId, p.tagIds]);
      if (tags.rows.length !== new Set(p.tagIds).size) { await client.query('ROLLBACK'); return null; }
      for (const row of tags.rows) tagNames.set(Number(row.id), String(row.name));
    }
    const { rows } = await client.query(`INSERT INTO whatsapp_opportunities
      (whatsapp_number_id, workspace_id, identifier, title, status, qualification, created_by)
      VALUES ($1,$2,$3,$4,'em_andamento',$5,$6) RETURNING id`,
    [p.numberId, p.workspaceId, p.identifier, p.title ?? null, p.qualification ?? 'indefinido', p.createdBy]);
    const id = Number(rows[0].id);
    await insertEvent(client, { opportunityId: id, field: 'created', oldValue: null, newValue: null, changedBy: p.createdBy });
    for (const tagId of new Set(p.tagIds ?? [])) {
      await client.query(`INSERT INTO whatsapp_opportunity_tags (opportunity_id, tag_id) VALUES ($1,$2)`, [id, tagId]);
      // Timeline canônica: etiqueta inicial também é tag_added (paridade com attach avulso e com o CLI de migração).
      await insertEvent(client, { opportunityId: id, field: 'tag_added', oldValue: null, newValue: tagNames.get(tagId) ?? null, changedBy: p.createdBy });
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
  if (transition.events.length === 0) return withoutScope(current);
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

// ---------------------------------------------------------------------------
// Data layer v3 — lock por conversa, dual-write is_qualified/qualification,
// side-effect na thread (spec §4.11 + §4.1-4.2). Convive com o v2 acima; as
// rotas migram na Task 8 (aí patchOpportunity/createOpportunity v2 saem).
// ---------------------------------------------------------------------------

/**
 * Conta oportunidades abertas (em_andamento) do par (número, identifier). Recebe
 * um PoolClient pra rodar DENTRO do lock — o poller (Fase B) usa isto pra re-checar
 * "zero abertas" atomicamente antes de criar. Usa o índice parcial idx_opp_open_pair.
 */
export async function countOpenOpportunities(client: PoolClient, numberId: number, identifier: string): Promise<number> {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM whatsapp_opportunities
      WHERE whatsapp_number_id = $1 AND identifier = $2 AND status = 'em_andamento'`,
    [numberId, identifier]);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Side-effect §4.1-4.2: quando o resultado da opp é ganho/qualificado/desqualificado,
 * a thread vira lead. Faz upsert incondicional de is_lead=TRUE, mas grava no
 * whatsapp_thread_meta_log SÓ SE o valor anterior era diferente de TRUE (sem row
 * anterior conta como diferente). Log incondicional travaria o sticky da IA (§6)
 * num mero title-edit de opp já ganha. Roda dentro da transação do lock (client).
 * Exportada pro teste puro da invariante do log.
 */
export async function applyThreadLeadTrue(
  client: Pick<PoolClient, 'query'>,
  p: { numberId: number; identifier: string; actor: string },
): Promise<void> {
  const prev = await client.query(
    `SELECT is_lead FROM whatsapp_thread_meta WHERE whatsapp_number_id = $1 AND identifier = $2`,
    [p.numberId, p.identifier]);
  const prevRow = prev.rows[0];
  const wasTrue = prevRow != null && prevRow.is_lead === true;
  await client.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead, updated_at, updated_by)
     VALUES ($1, $2, TRUE, NOW(), $3)
     ON CONFLICT (whatsapp_number_id, identifier)
     DO UPDATE SET is_lead = TRUE, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [p.numberId, p.identifier, p.actor]);
  if (!wasTrue) {
    await client.query(
      `INSERT INTO whatsapp_thread_meta_log (whatsapp_number_id, identifier, field, old_value, new_value, actor)
       VALUES ($1, $2, 'is_lead', $3, 'true', $4)`,
      [p.numberId, p.identifier, prevRow != null ? String(prevRow.is_lead) : null, p.actor]);
  }
}

/**
 * Cria oportunidade v3 sob o lock da conversa. Escreve as duas colunas de
 * qualificação (is_qualified + qualification derivada, DUAL WRITE até a Fase D)
 * e mantém os eventos `created` + `tag_added` (paridade v2). Tag inexistente no
 * workspace → null (nada é inserido; a transação do lock commita vazia).
 */
export async function createOpportunityV3(pool: Pool, p: {
  numberId: number; workspaceId: string; identifier: string; title?: string | null;
  isQualified?: boolean | null; tagIds?: number[]; createdBy: string;
}): Promise<Opportunity | null> {
  return withConversationLock(pool, p.numberId, p.identifier, async (client) => {
    const isQ = p.isQualified ?? null;
    const tagNames = new Map<number, string>();
    if (p.tagIds?.length) {
      const tags = await client.query(`SELECT id, name FROM whatsapp_tags WHERE workspace_id=$1 AND id=ANY($2::bigint[])`, [p.workspaceId, p.tagIds]);
      if (tags.rows.length !== new Set(p.tagIds).size) return null;
      for (const row of tags.rows) tagNames.set(Number(row.id), String(row.name));
    }
    const { rows } = await client.query(`INSERT INTO whatsapp_opportunities
      (whatsapp_number_id, workspace_id, identifier, title, status, is_qualified, qualification, created_by)
      VALUES ($1,$2,$3,$4,'em_andamento',$5,$6,$7) RETURNING id`,
    [p.numberId, p.workspaceId, p.identifier, p.title ?? null, isQ, qualificationLabel(isQ), p.createdBy]);
    const id = Number(rows[0].id);
    await insertEvent(client, { opportunityId: id, field: 'created', oldValue: null, newValue: null, changedBy: p.createdBy });
    for (const tagId of new Set(p.tagIds ?? [])) {
      await client.query(`INSERT INTO whatsapp_opportunity_tags (opportunity_id, tag_id) VALUES ($1,$2)`, [id, tagId]);
      // Timeline canônica: etiqueta inicial também é tag_added (paridade com o v2).
      await insertEvent(client, { opportunityId: id, field: 'tag_added', oldValue: null, newValue: tagNames.get(tagId) ?? null, changedBy: p.createdBy });
    }
    const { rows: after } = await client.query(`${OPP_SELECT} WHERE o.id = $1`, [id]);
    return after[0] ? mapOpportunity(after[0]) : null;
  });
}

/**
 * Aplica um patch v3 INTEIRO sob o lock da conversa da opp: relê a row DENTRO do
 * lock (mata o stale-snapshot do v2), roda o kernel (`applyOppPatchV3`), escreve
 * o UPDATE com colunas EXPLÍCITAS (dual-write is_qualified + qualification, mais
 * loss_reason e closed_at conforme closedAtAction), grava os eventos e — quando o
 * kernel emite threadLeadAction='set_true' — o side-effect da thread. Tudo na
 * mesma transação. Erros de invariante viram o union de erro (não lançam).
 */
export async function patchOpportunityV3(
  pool: Pool, opportunityId: number, patch: OppPatchV3, changedBy: string,
): Promise<{ ok: true; opportunity: Opportunity } | { ok: false; error: 'not_found' | 'desqualificar_ganho' | 'invalid_value' }> {
  // Descobre o par (número, identifier) pra chave do lock. A leitura autoritativa
  // do estado é refeita DENTRO do lock; se a row sumir lá, devolve not_found.
  const head = await pool.query(`SELECT whatsapp_number_id, identifier FROM whatsapp_opportunities WHERE id = $1`, [opportunityId]);
  if (!head.rows[0]) return { ok: false, error: 'not_found' };
  const numberId = Number(head.rows[0].whatsapp_number_id);
  const identifier = String(head.rows[0].identifier);
  try {
    return await withConversationLock<{ ok: true; opportunity: Opportunity } | { ok: false; error: 'not_found' }>(
      pool, numberId, identifier, async (client) => {
        const { rows } = await client.query(`${OPP_SELECT} WHERE o.id = $1`, [opportunityId]);
        const row = rows[0];
        if (!row) return { ok: false, error: 'not_found' };
        const cur: OppStateV3 = {
          status: row.status,
          isQualified: row.is_qualified === undefined ? null : row.is_qualified,
          closedAt: row.closed_at ? iso(row.closed_at) : null,
          title: row.title,
          lossReason: row.loss_reason ?? null,
        };
        const transition = applyOppPatchV3(cur, patch); // lança OppInvariantError → catch abaixo
        if (transition.events.length > 0) {
          const next = transition.next;
          const closedAtExpr =
            transition.closedAtAction === 'set_now' ? 'NOW()'
              : transition.closedAtAction === 'clear' ? 'NULL'
                : 'closed_at';
          await client.query(
            `UPDATE whatsapp_opportunities SET
               status = $2, is_qualified = $3, qualification = $4, title = $5, loss_reason = $6,
               closed_at = ${closedAtExpr}, updated_at = NOW()
             WHERE id = $1`,
            [opportunityId, next.status, next.isQualified, qualificationLabel(next.isQualified), next.title, next.lossReason]);
          for (const ev of transition.events) {
            await insertEvent(client, { opportunityId, field: ev.field, oldValue: ev.oldValue, newValue: ev.newValue, changedBy });
          }
        }
        // §4.1-4.2: side-effect roda mesmo em patch sem eventos de opp (ex.: title-only
        // numa ganha, ou re-qualificar idêntico) — o guard de log evita spam no sticky.
        if (transition.threadLeadAction === 'set_true') {
          await applyThreadLeadTrue(client, { numberId, identifier, actor: changedBy });
        }
        const { rows: after } = await client.query(`${OPP_SELECT} WHERE o.id = $1`, [opportunityId]);
        return { ok: true, opportunity: mapOpportunity(after[0]) };
      });
  } catch (err) {
    if (err instanceof OppInvariantError) return { ok: false, error: err.code };
    throw err;
  }
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
