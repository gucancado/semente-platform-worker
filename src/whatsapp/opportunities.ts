import type { Pool, PoolClient } from 'pg';
import {
  applyOppPatchV3,
  boardColumn,
  OppInvariantError,
  qualificationLabel,
  type BoardColumn,
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
  // v3 contract (mig 053): is_qualified é a ÚNICA fonte da verdade (NULL=indefinido/
  // TRUE=qualificado/FALSE=desqualificado) — a coluna legada `qualification` foi
  // dropada do banco. `qualification` aqui continua exposta nas respostas, mas
  // SEMPRE derivada de is_qualified (nunca lida do banco).
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
export const mapOpportunity = (r: any): Opportunity => {
  const isQualified = r.is_qualified === undefined ? null : r.is_qualified;
  return {
    id: Number(r.id),
    identifier: r.identifier, title: r.title, status: r.status,
    isQualified,
    lossReason: r.loss_reason ?? null,
    // v3 contract (mig 053): SEMPRE derivada de is_qualified — a coluna legada
    // `qualification` não existe mais no banco.
    qualification: qualificationLabel(isQualified),
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    closedAt: r.closed_at ? iso(r.closed_at) : null, createdBy: r.created_by,
    tags: Array.isArray(r.tags) ? r.tags.map(mapTag) : [],
  };
};
const mapScopedOpportunity = (r: any): ScopedOpportunity => ({
  ...mapOpportunity(r),
  numberId: Number(r.whatsapp_number_id),
  workspaceId: r.workspace_id,
});

// SELECT o.* já traz as colunas v3 (is_qualified, loss_reason) desde a migration 051.
// v3 contract (mig 053): a coluna legada `qualification` NÃO existe mais — não vem
// mais no `o.*`; mapOpportunity deriva a string sempre de is_qualified.
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

// Exportada (Task D4): o aplicador do julgamento IA grava eventos (tag_added etc.) com
// changedBy='ai' DENTRO do seu próprio lock, reusando esta escrita canônica.
export async function insertEvent(client: Pick<PoolClient, 'query'>, p: {
  opportunityId: number; field: string; oldValue: string | null; newValue: string | null; changedBy: string;
}) {
  await client.query(`INSERT INTO whatsapp_opportunity_events
    (opportunity_id, field, old_value, new_value, changed_by) VALUES ($1,$2,$3,$4,$5)`,
  [p.opportunityId, p.field, p.oldValue, p.newValue, p.changedBy]);
}

/**
 * INSERT de uma opp `em_andamento` + evento `created`, DENTRO de uma transação/lock já
 * abertos (recebe o `client`). Extraído de createOpportunityV3 (comportamento idêntico —
 * mesmo SQL, mesmo evento) para ser reusado pelo aplicador do julgamento IA (D4,
 * closed_action='criar_nova') SEM abrir um lock próprio: createOpportunityV3 abriria
 * OUTRA sessão/lock (pool.connect novo) = deadlock com o lock do aplicador. NÃO faz o
 * side-effect de thread nem tags — quem precisa (createOpportunityV3) faz depois, na
 * mesma transação, preservando a ordem original.
 */
export async function insertOpportunityInTx(client: Pick<PoolClient, 'query'>, p: {
  numberId: number; workspaceId: string; identifier: string; title?: string | null;
  isQualified?: boolean | null; createdBy: string;
}): Promise<number> {
  const isQ = p.isQualified ?? null;
  const { rows } = await client.query(`INSERT INTO whatsapp_opportunities
    (whatsapp_number_id, workspace_id, identifier, title, status, is_qualified, created_by)
    VALUES ($1,$2,$3,$4,'em_andamento',$5,$6) RETURNING id`,
  [p.numberId, p.workspaceId, p.identifier, p.title ?? null, isQ, p.createdBy]);
  const id = Number(rows[0].id);
  await insertEvent(client, { opportunityId: id, field: 'created', oldValue: null, newValue: null, changedBy: p.createdBy });
  return id;
}

// ---------------------------------------------------------------------------
// Data layer v3 — lock por conversa, escrita SÓ is_qualified (v3 contract, mig
// 053 — a coluna legada `qualification` foi dropada), side-effect na thread
// (spec §4.11 + §4.1-4.2). É o ÚNICO caminho de escrita das rotas desde a Task 8
// (o createOpportunity/patchOpportunity v2 saíram).
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
 * Conta oportunidades do par (número, identifier) em QUALQUER status (diferente
 * de countOpenOpportunities, que só conta em_andamento). Recebe um PoolClient pra
 * rodar DENTRO do lock — é a re-checagem atômica do poller de criação (Fase B):
 * "este par nunca teve oportunidade" só é seguro de afirmar DENTRO da transação
 * que vai inserir, senão uma corrida entre o SELECT do sweep e o lock duplicaria.
 */
export async function countAnyOpportunities(client: PoolClient, numberId: number, identifier: string): Promise<number> {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM whatsapp_opportunities
      WHERE whatsapp_number_id = $1 AND identifier = $2`,
    [numberId, identifier]);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Side-effect §4.1-4.2 GENERALIZADO: escreve a triagem da thread para `value`
 * (TRUE=lead ou NULL=indefinido — NUNCA FALSE por aqui; a cascata não-lead tem
 * caminho próprio em thread-meta.ts `cascadeNotLead`). Faz upsert INCONDICIONAL do
 * valor, mas grava no whatsapp_thread_meta_log SÓ SE o valor efetivo mudou (sem row
 * anterior conta como NULL). Log incondicional travaria o sticky da IA (§6) num
 * mero title-edit de opp já ganha, ou num drop na mesma coluna. Devolve `changed`
 * (se logou) — usado pela rota `move` pra distinguir no-op de transição real.
 *
 * O novo valor entra como TOKEN LITERAL no SQL (TRUE/NULL) — não parametrizado —
 * então os params (upsert=3, log=4) e a forma do statement independem do valor:
 * `applyThreadLead(client, p, true)` é byte-a-byte o antigo `applyThreadLeadTrue`.
 *
 * CONTRATO: DEVE ser chamada DENTRO de withConversationLock (mesma transação) — o
 * upsert e o log são 2 statements e exigem atomicidade: sem a transação, um crash
 * entre eles deixa is_lead escrito sem log (ou uma corrida duplica o log).
 */
export async function applyThreadLead(
  client: Pick<PoolClient, 'query'>,
  p: { numberId: number; identifier: string; changedBy: string },
  value: true | null,
): Promise<boolean> {
  const prev = await client.query(
    `SELECT is_lead FROM whatsapp_thread_meta WHERE whatsapp_number_id = $1 AND identifier = $2`,
    [p.numberId, p.identifier]);
  const prevRow = prev.rows[0];
  // Sem row OU is_lead NULL contam ambos como NULL (não-triado).
  const prevValue: boolean | null = prevRow == null || prevRow.is_lead == null ? null : prevRow.is_lead;
  const changed = prevValue !== value;
  const valueSql = value === true ? 'TRUE' : 'NULL';
  await client.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead, updated_at, updated_by)
     VALUES ($1, $2, ${valueSql}, NOW(), $3)
     ON CONFLICT (whatsapp_number_id, identifier)
     DO UPDATE SET is_lead = ${valueSql}, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [p.numberId, p.identifier, p.changedBy]);
  if (changed) {
    await client.query(
      `INSERT INTO whatsapp_thread_meta_log (whatsapp_number_id, identifier, field, old_value, new_value, actor)
       VALUES ($1, $2, 'is_lead', $3, ${value === true ? `'true'` : 'NULL'}, $4)`,
      // old_value NULL (não-triado) grava NULL — não a string 'null'.
      [p.numberId, p.identifier, prevValue == null ? null : String(prevValue), p.changedBy]);
  }
  return changed;
}

/**
 * @deprecated Use `applyThreadLead(client, {..., changedBy}, true)`. Wrapper fino
 * mantido pelos call sites de criação (createOpportunityV3) e pelos testes: mesmo
 * SQL, sem valor de retorno.
 */
export async function applyThreadLeadTrue(
  client: Pick<PoolClient, 'query'>,
  p: { numberId: number; identifier: string; actor: string },
): Promise<void> {
  await applyThreadLead(client, { numberId: p.numberId, identifier: p.identifier, changedBy: p.actor }, true);
}

/**
 * Cria oportunidade v3 sob o lock da conversa. v3 contract (mig 053): escreve
 * SÓ is_qualified — a coluna legada `qualification` foi dropada (dual-write saiu
 * junto com o trigger de sincronia da 051). Mantém os eventos `created` +
 * `tag_added` (paridade v2). Tag inexistente no workspace → null (nada é
 * inserido; a transação do lock commita vazia).
 *
 * `isQualified` aceita SÓ {null/undefined, true}:
 *  - `false` → OppInvariantError('invalid_value') ANTES de qualquer escrita. Regra v1:
 *    não se cria oportunidade já fechada, e desqualificada-ao-nascer seria
 *    em_andamento+FALSE (viola o CHECK opp_v3_desqualificado_perdido) ou uma perda
 *    sem razão. Desqualificar é sempre um patch sobre opp existente.
 *  - `true` → cascateia is_lead=TRUE na thread (§4.2) na MESMA transação sob o lock,
 *    com o mesmo dedupe de log; senão nasceria em_andamento+TRUE+is_lead NULL, estado
 *    que a spec §5 declara inalcançável (cairia em novas_conversas, não negociacoes).
 */
export async function createOpportunityV3(pool: Pool, p: {
  numberId: number; workspaceId: string; identifier: string; title?: string | null;
  isQualified?: boolean | null; tagIds?: number[]; createdBy: string;
}): Promise<Opportunity | null>;
/**
 * Sobrecarga usada SÓ pelo poller de criação (Fase B, `opportunity-pipeline.ts`):
 * `skipIfAnyOpportunity: true` faz o create RE-CHECAR, dentro da mesma transação/
 * lock, se o par (número, identifier) já tem QUALQUER oportunidade (não só
 * em_andamento — `countAnyOpportunities`) ANTES do INSERT. Se >0, devolve
 * `{ skipped: true }` sem inserir — cobre a corrida entre o SELECT de candidatos
 * do sweep (fora do lock) e o momento em que este create toma o lock (outro sweep,
 * ou um humano criando manualmente, pode ter criado a opp nesse intervalo). Fora
 * do poller NUNCA passar esta flag — um create manual (rota) pode coexistir com
 * opps fechadas do mesmo par (reabertura é um fluxo válido).
 */
export async function createOpportunityV3(pool: Pool, p: {
  numberId: number; workspaceId: string; identifier: string; title?: string | null;
  isQualified?: boolean | null; tagIds?: number[]; createdBy: string; skipIfAnyOpportunity: true;
}): Promise<Opportunity | null | { skipped: true }>;
export async function createOpportunityV3(pool: Pool, p: {
  numberId: number; workspaceId: string; identifier: string; title?: string | null;
  isQualified?: boolean | null; tagIds?: number[]; createdBy: string; skipIfAnyOpportunity?: boolean;
}): Promise<Opportunity | null | { skipped: true }> {
  if (p.isQualified === false) throw new OppInvariantError('invalid_value');
  return withConversationLock(pool, p.numberId, p.identifier, async (client) => {
    if (p.skipIfAnyOpportunity) {
      const anyCount = await countAnyOpportunities(client, p.numberId, p.identifier);
      if (anyCount > 0) return { skipped: true };
    }
    const isQ = p.isQualified ?? null;
    const tagNames = new Map<number, string>();
    if (p.tagIds?.length) {
      const tags = await client.query(`SELECT id, name FROM whatsapp_tags WHERE workspace_id=$1 AND id=ANY($2::bigint[])`, [p.workspaceId, p.tagIds]);
      if (tags.rows.length !== new Set(p.tagIds).size) return null;
      for (const row of tags.rows) tagNames.set(Number(row.id), String(row.name));
    }
    const id = await insertOpportunityInTx(client, {
      numberId: p.numberId, workspaceId: p.workspaceId, identifier: p.identifier,
      title: p.title ?? null, isQualified: isQ, createdBy: p.createdBy,
    });
    for (const tagId of new Set(p.tagIds ?? [])) {
      await client.query(`INSERT INTO whatsapp_opportunity_tags (opportunity_id, tag_id) VALUES ($1,$2)`, [id, tagId]);
      // Timeline canônica: etiqueta inicial também é tag_added (paridade com o v2).
      await insertEvent(client, { opportunityId: id, field: 'tag_added', oldValue: null, newValue: tagNames.get(tagId) ?? null, changedBy: p.createdBy });
    }
    // §4.2: criada já qualificada ⇒ a thread é lead. Mesma transação, mesmo dedupe.
    if (isQ === true) {
      await applyThreadLeadTrue(client, { numberId: p.numberId, identifier: p.identifier, actor: p.createdBy });
    }
    const { rows: after } = await client.query(`${OPP_SELECT} WHERE o.id = $1`, [id]);
    return after[0] ? mapOpportunity(after[0]) : null;
  });
}

/**
 * Aplica UM patch v3 já validado no par pela via do kernel, DENTRO de uma
 * transação/lock já abertos, sobre o estado `cur` já relido. Concentra as escritas
 * de opp (UPDATE + eventos — v3 contract, mig 053: só is_qualified, sem a coluna
 * legada `qualification`) e o side-effect de thread (§4.1-4.2) num só lugar —
 * reusado por `patchOpportunityGuarded` E por `moveOpportunity`, pra não
 * duplicar o SQL do UPDATE/eventos. Lança `OppInvariantError` (do kernel) — quem
 * chama trata no catch. Devolve o que de fato mudou:
 *  - `oppChanged`: houve UPDATE/eventos de opp (transition.events > 0);
 *  - `threadChanged`: o side-effect `set_true` do kernel realmente logou a thread.
 */
// Exportada (Task D4): o aplicador do julgamento IA reusa este aplicador de patch
// (kernel + UPDATE + eventos + side-effect de thread) DENTRO do seu próprio lock, em vez
// de patchOpportunityGuarded (que abriria outra sessão/lock = deadlock). Lança
// OppInvariantError — o chamador trata no catch (skip note, sem abortar o resto).
export async function applyOppPatchInTx(
  client: PoolClient,
  opportunityId: number,
  cur: OppStateV3,
  patch: OppPatchV3,
  changedBy: string,
  pair: { numberId: number; identifier: string },
): Promise<{ oppChanged: boolean; threadChanged: boolean }> {
  const transition = applyOppPatchV3(cur, patch); // lança OppInvariantError → catch do chamador
  let oppChanged = false;
  if (transition.events.length > 0) {
    oppChanged = true;
    const next = transition.next;
    const closedAtExpr =
      transition.closedAtAction === 'set_now' ? 'NOW()'
        : transition.closedAtAction === 'clear' ? 'NULL'
          : 'closed_at';
    await client.query(
      `UPDATE whatsapp_opportunities SET
         status = $2, is_qualified = $3, title = $4, loss_reason = $5,
         closed_at = ${closedAtExpr}, updated_at = NOW()
       WHERE id = $1`,
      [opportunityId, next.status, next.isQualified, next.title, next.lossReason]);
    for (const ev of transition.events) {
      await insertEvent(client, { opportunityId, field: ev.field, oldValue: ev.oldValue, newValue: ev.newValue, changedBy });
    }
  }
  // §4.1-4.2: side-effect roda mesmo em patch sem eventos de opp (ex.: title-only
  // numa ganha, ou re-qualificar idêntico) — o guard de log evita spam no sticky.
  let threadChanged = false;
  if (transition.threadLeadAction === 'set_true') {
    threadChanged = await applyThreadLead(client, { numberId: pair.numberId, identifier: pair.identifier, changedBy }, true);
  }
  return { oppChanged, threadChanged };
}

/**
 * Guard avaliado DENTRO do lock, logo após o re-read do estado atual da opp e
 * ANTES de qualquer escrita (kernel/UPDATE/eventos). Devolver `false` aborta o
 * patch inteiro sem escrever nada — ver `patchOpportunityGuarded`.
 */
export type PatchGuard = (client: PoolClient, current: OppStateV3) => Promise<boolean>;

/**
 * Aplica um patch v3 INTEIRO sob o lock da conversa da opp: relê a row DENTRO do
 * lock (mata o stale-snapshot do v2), chama `guard(client, current)` — se `false`,
 * devolve `{ok:false, error:'conflict'}` SEM escrever nada (a transação comita
 * vazia; equivalente a rollback, já que nenhum statement de escrita rodou) — roda
 * o kernel (`applyOppPatchV3`), escreve o UPDATE com colunas EXPLÍCITAS (v3
 * contract, mig 053: is_qualified, mais loss_reason e closed_at conforme
 * closedAtAction — sem a coluna legada `qualification`), grava os eventos e —
 * quando o kernel emite threadLeadAction='set_true' — o side-effect da thread.
 * Tudo na mesma transação.
 * Erros de invariante viram o union de erro (não lançam).
 *
 * O guard existe pra jobs automáticos (ex.: auto-loss, Fase B) que decidem fechar
 * uma opp com base num SELECT de candidatos feito FORA do lock: entre esse SELECT
 * e o momento em que este patch toma o lock, um humano pode ter mudado o status
 * (ex.: marcar ganho) ou uma mensagem nova pode ter chegado — o guard confirma,
 * sob o MESMO lock que vai escrever, que a premissa que motivou o patch continua
 * verdadeira. `patchOpportunityV3` é este mesmo código com um guard sempre-true
 * (zero duplicação) — rotas humanas não têm essa janela de decisão externa, então
 * nunca precisam de guard.
 */
export async function patchOpportunityGuarded(
  pool: Pool, opportunityId: number, patch: OppPatchV3, changedBy: string, guard: PatchGuard,
): Promise<{ ok: true; opportunity: Opportunity } | { ok: false; error: 'not_found' | 'desqualificar_ganho' | 'invalid_value' | 'conflict' }> {
  // Descobre o par (número, identifier) pra chave do lock. A leitura autoritativa
  // do estado é refeita DENTRO do lock; se a row sumir lá, devolve not_found.
  const head = await pool.query(`SELECT whatsapp_number_id, identifier FROM whatsapp_opportunities WHERE id = $1`, [opportunityId]);
  if (!head.rows[0]) return { ok: false, error: 'not_found' };
  const numberId = Number(head.rows[0].whatsapp_number_id);
  const identifier = String(head.rows[0].identifier);
  try {
    return await withConversationLock<{ ok: true; opportunity: Opportunity } | { ok: false; error: 'not_found' | 'conflict' }>(
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
        if (!(await guard(client, cur))) return { ok: false, error: 'conflict' };
        await applyOppPatchInTx(client, opportunityId, cur, patch, changedBy, { numberId, identifier });
        const { rows: after } = await client.query(`${OPP_SELECT} WHERE o.id = $1`, [opportunityId]);
        return { ok: true, opportunity: mapOpportunity(after[0]) };
      });
  } catch (err) {
    if (err instanceof OppInvariantError) return { ok: false, error: err.code };
    throw err;
  }
}

/**
 * Patch v3 sem guard externo (uso das rotas humanas — não há SELECT-fora-do-lock
 * a proteger). Delega inteiramente pra `patchOpportunityGuarded` com um guard
 * sempre-true: 'conflict' nunca é alcançável por essa via, então o cast abaixo é
 * seguro (o guard nunca devolve false).
 */
export async function patchOpportunityV3(
  pool: Pool, opportunityId: number, patch: OppPatchV3, changedBy: string,
): Promise<{ ok: true; opportunity: Opportunity } | { ok: false; error: 'not_found' | 'desqualificar_ganho' | 'invalid_value' }> {
  return patchOpportunityGuarded(pool, opportunityId, patch, changedBy, async () => true) as Promise<
    { ok: true; opportunity: Opportunity } | { ok: false; error: 'not_found' | 'desqualificar_ganho' | 'invalid_value' }
  >;
}

export type MoveResult =
  | { ok: true; opportunity: Opportunity; column: BoardColumn | null; moved: boolean }
  | { ok: false; error: 'not_found' | 'invalid_value' | 'desqualificar_ganho' };

/**
 * Rota do drag-and-drop do kanban (spec §5/§10): UMA chamada que executa a
 * transição de coluna INTEIRA (opp + thread + eventos) numa única transação sob o
 * lock do par (§4.11), relendo o estado DENTRO do lock. A coluna alvo deriva o
 * patch da opp e o alvo de thread (tabela §5):
 *
 *  | coluna          | patch da opp                              | thread          |
 *  |-----------------|-------------------------------------------|-----------------|
 *  | novas_conversas | reabre se fechada; is_qualified=NULL       | is_lead=NULL     |
 *  | interessados    | reabre se fechada; is_qualified=NULL       | is_lead=TRUE     |
 *  | negociacoes     | status=em_andamento; is_qualified=TRUE      | TRUE via kernel  |
 *  | ganhos          | status=ganho                               | TRUE via kernel  |
 *  | perdas          | status=perdido; loss_reason=<motivo>       | (não toca)       |
 *
 * `negociacoes`/`ganhos` não escrevem a thread aqui: is_qualified=TRUE e status=ganho
 * já fazem o kernel emitir `set_true` (via applyOppPatchInTx). `perdas` não muda a
 * triagem. As escritas de opp reusam os internals de patch (applyOppPatchInTx) — mesmo
 * kernel/UPDATE/eventos, sem duplicar SQL. Ator = usuário real (`changedBy`).
 *
 * No-op (estado final == atual E thread já no valor) → `moved:false`, sem eventos.
 * A `column` devolvida é RECALCULADA do estado final via `boardColumn` (honesta).
 * Invariantes de kernel (invalid_value/desqualificar_ganho) viram o union de erro.
 */
export async function moveOpportunity(
  pool: Pool, opportunityId: number, column: BoardColumn, lossReason: string | null, changedBy: string,
): Promise<MoveResult> {
  const head = await pool.query(`SELECT whatsapp_number_id, identifier FROM whatsapp_opportunities WHERE id = $1`, [opportunityId]);
  if (!head.rows[0]) return { ok: false, error: 'not_found' };
  const numberId = Number(head.rows[0].whatsapp_number_id);
  const identifier = String(head.rows[0].identifier);
  try {
    return await withConversationLock<MoveResult>(pool, numberId, identifier, async (client) => {
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
      // "reabre se fechada": só injeta status=em_andamento quando NÃO está aberta
      // (kernel no-opa status igual; mas é a reabertura perdido→em_andamento que
      // limpa loss_reason/desqualificação — precisa do status explícito).
      const reopen: Pick<OppPatchV3, 'status'> = cur.status !== 'em_andamento' ? { status: 'em_andamento' } : {};
      let patch: OppPatchV3;
      let threadTarget: true | null | undefined; // escrita EXPLÍCITA de thread; undefined = deixa pro kernel
      // TODO(Task 2): 'perdas' saiu do board (perder = patch na conversa; reabrir =
      // move p/ coluna viva). O `case 'perdas'` (status=perdido; loss_reason=<motivo>)
      // foi REMOVIDO aqui só pra fechar o tsc — o tipo BoardColumn já não inclui
      // 'perdas' (TS2678) e `isBoardColumn` a rejeita na rota (400), então este switch
      // NUNCA recebia 'perdas'. Sem mudança de comportamento (ramo inalcançável). A
      // Task 2 reescreve moveOpportunity (semântica de reabrir) e remove o param
      // `lossReason`, hoje órfão.
      switch (column) {
        case 'novas_conversas': patch = { ...reopen, isQualified: null }; threadTarget = null; break;
        case 'interessados': patch = { ...reopen, isQualified: null }; threadTarget = true; break;
        case 'negociacoes': patch = { status: 'em_andamento', isQualified: true }; threadTarget = undefined; break;
        case 'ganhos': patch = { status: 'ganho' }; threadTarget = undefined; break;
      }
      const oppResult = await applyOppPatchInTx(client, opportunityId, cur, patch, changedBy, { numberId, identifier });
      let explicitThreadChanged = false;
      if (threadTarget !== undefined) {
        explicitThreadChanged = await applyThreadLead(client, { numberId, identifier, changedBy }, threadTarget);
      }
      const moved = oppResult.oppChanged || oppResult.threadChanged || explicitThreadChanged;
      const { rows: after } = await client.query(`${OPP_SELECT} WHERE o.id = $1`, [opportunityId]);
      const opportunity = mapOpportunity(after[0]);
      const leadRes = await client.query(
        `SELECT is_lead FROM whatsapp_thread_meta WHERE whatsapp_number_id = $1 AND identifier = $2`, [numberId, identifier]);
      const finalIsLead: boolean | null = leadRes.rows[0] ? (leadRes.rows[0].is_lead ?? null) : null;
      const finalColumn = boardColumn(finalIsLead, {
        status: opportunity.status, isQualified: opportunity.isQualified, lossReason: opportunity.lossReason,
      });
      return { ok: true, opportunity, column: finalColumn, moved };
    });
  } catch (err) {
    if (err instanceof OppInvariantError) return { ok: false, error: err.code };
    throw err;
  }
}

/**
 * Deleta a oportunidade SOB o lock da conversa (spec §4.11) — nunca fora dele:
 * um DELETE concorrente com um patch/cascata/side-effect da mesma conversa
 * corromperia o estado (ex.: cascadeNotLead fecharia uma opp já apagada, ou o
 * side-effect da thread rodaria contra uma opp inexistente). Descobre o par
 * (número, identifier) pra chave do lock, entra no lock, RE-LÊ a row dentro da
 * transação (sumiu entre a descoberta e o lock → not_found) e só então DELETE.
 * A FK ON DELETE CASCADE cobre eventos e tags.
 */
export async function deleteOpportunityV3(
  pool: Pool, id: number,
): Promise<{ ok: true } | { ok: false; error: 'not_found' }> {
  const head = await pool.query(`SELECT whatsapp_number_id, identifier FROM whatsapp_opportunities WHERE id = $1`, [id]);
  if (!head.rows[0]) return { ok: false, error: 'not_found' };
  const numberId = Number(head.rows[0].whatsapp_number_id);
  const identifier = String(head.rows[0].identifier);
  return withConversationLock<{ ok: true } | { ok: false; error: 'not_found' }>(
    pool, numberId, identifier, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM whatsapp_opportunities WHERE id = $1`, [id]);
      if (!rows[0]) return { ok: false, error: 'not_found' };
      await client.query(`DELETE FROM whatsapp_opportunities WHERE id = $1`, [id]);
      return { ok: true };
    });
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
