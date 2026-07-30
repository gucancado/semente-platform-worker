import type { Pool, PoolClient } from 'pg';
import { withConversationLock } from './conversation-lock.js';

/** Parameters shared by the single and bulk lead-triage update paths. */
export interface LeadUpdateParams {
  numberId: number;
  identifier: string;
  /** Tri-state (v3): TRUE=lead, FALSE=não-lead, NULL=não triado (indefinido). */
  isLead: boolean | null;
  updatedBy: string;
  source?: string | null;
  sourcePresent?: boolean;
  disqualifyReason?: string | null;
  disqualifyReasonPresent?: boolean;
  notes?: string | null;
  notesPresent?: boolean;
}

/**
 * Lançada quando a triagem tenta marcar não-lead (is_lead=FALSE) numa conversa
 * que tem oportunidade GANHA — a cascata aborta tudo (spec §4.8). O par (número,
 * identifier) é reduzido a `identifier` aqui porque a rota já conhece o número.
 */
export class LeadCascadeGanhoError extends Error {
  readonly identifier: string;
  constructor(identifier: string) {
    super(`possui_ganho: ${identifier}`);
    this.name = 'LeadCascadeGanhoError';
    this.identifier = identifier;
  }
}

/**
 * Representa o valor de is_lead como texto pro log (TRUE/FALSE/NULL → 'true'/'false'/null).
 * NULL (não-triado) grava old/new_value NULL, distinto de 'true'/'false'.
 */
const leadLogValue = (v: boolean | null): string | null => (v === null ? null : String(v));

/**
 * Cascata não-lead (spec §4.8), DENTRO da transação do par (mesmo lock):
 *  (a) existe opp status='ganho' → lança LeadCascadeGanhoError (nada é gravado);
 *  (b) opps 'em_andamento' → fecha como 'perdido' / loss_reason='nao_lead' (is_qualified
 *      e qualification INTACTAS) + 2 eventos por opp ('status' e 'loss_reason'),
 *      changed_by='system' (a decisão humana fica no log da thread, não aqui).
 */
async function cascadeNotLead(client: Pick<PoolClient, 'query'>, numberId: number, identifier: string): Promise<void> {
  const ganho = await client.query(
    `SELECT 1 FROM whatsapp_opportunities
      WHERE whatsapp_number_id = $1 AND identifier = $2 AND status = 'ganho' LIMIT 1`,
    [numberId, identifier],
  );
  if (ganho.rows.length > 0) throw new LeadCascadeGanhoError(identifier);

  const closed = await client.query<{ id: string }>(
    `UPDATE whatsapp_opportunities
        SET status = 'perdido', loss_reason = 'nao_lead', closed_at = NOW(), updated_at = NOW()
      WHERE whatsapp_number_id = $1 AND identifier = $2 AND status = 'em_andamento'
      RETURNING id`,
    [numberId, identifier],
  );
  for (const row of closed.rows) {
    await client.query(
      `INSERT INTO whatsapp_opportunity_events (opportunity_id, field, old_value, new_value, changed_by)
       VALUES ($1, 'status', 'em_andamento', 'perdido', 'system'),
              ($1, 'loss_reason', NULL, 'nao_lead', 'system')`,
      [Number(row.id)],
    );
  }
}

/**
 * Aplica uma atualização de triagem dentro de uma transação já aberta (sob o lock
 * do par — ver setLeadStatus/bulkSetLeadStatus). Stage, temperatura e tags legadas
 * ficam congeladas. is_lead=FALSE cascateia o fechamento das oportunidades abertas.
 */
export async function applyLeadUpdate(client: PoolClient, p: LeadUpdateParams): Promise<void> {
  const prev = await client.query<{ is_lead: boolean | null }>(
    `SELECT is_lead FROM whatsapp_thread_meta WHERE whatsapp_number_id = $1 AND identifier = $2`,
    [p.numberId, p.identifier],
  );
  const prevRow = prev.rows[0];
  const prevValue: boolean | null = prevRow != null ? prevRow.is_lead : null;
  const newValue: boolean | null = p.isLead;

  // §4.8: marcar não-lead fecha as oportunidades abertas do par. Roda ANTES do
  // upsert; opp ganha lança e o lock/transação desfaz tudo (nada gravado).
  if (newValue === false) {
    await cascadeNotLead(client, p.numberId, p.identifier);
  }

  await client.query(
    `INSERT INTO whatsapp_thread_meta
       (whatsapp_number_id, identifier, is_lead, lead_source, disqualify_reason, notes, updated_at, updated_by)
     VALUES ($1, $2, $3, $5, $7, $9, NOW(), $10)
     ON CONFLICT (whatsapp_number_id, identifier)
     DO UPDATE SET
       is_lead           = EXCLUDED.is_lead,
       lead_source       = CASE WHEN $4 THEN $5 ELSE whatsapp_thread_meta.lead_source END,
       disqualify_reason = CASE WHEN $6 THEN $7 ELSE whatsapp_thread_meta.disqualify_reason END,
       notes             = CASE WHEN $8 THEN $9 ELSE whatsapp_thread_meta.notes END,
       updated_at        = NOW(),
       updated_by        = EXCLUDED.updated_by`,
    [
      p.numberId,
      p.identifier,
      p.isLead,
      p.sourcePresent === true,
      p.source ?? null,
      p.disqualifyReasonPresent === true,
      p.disqualifyReason ?? null,
      p.notesPresent === true,
      p.notes ?? null,
      p.updatedBy,
    ],
  );

  // Log em thread_meta_log SÓ quando o valor efetivo de is_lead mudou (NULL≠TRUE≠FALSE).
  // Edição só de source/notes/disqualify_reason não gera row de is_lead.
  if (prevValue !== newValue) {
    await client.query(
      `INSERT INTO whatsapp_thread_meta_log (whatsapp_number_id, identifier, field, old_value, new_value, actor)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [p.numberId, p.identifier, 'is_lead', leadLogValue(prevValue), leadLogValue(newValue), p.updatedBy],
    );
  }
}

export async function setLeadStatus(pool: Pool, p: LeadUpdateParams): Promise<void> {
  await withConversationLock(pool, p.numberId, p.identifier, (client) => applyLeadUpdate(client, p));
}

export async function setGroupExposure(pool: Pool, p: { numberId: number; expose: boolean }): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_numbers SET expose_groups_in_mcp = $2, updated_at = NOW() WHERE id = $1`,
    [p.numberId, p.expose],
  );
}

export async function getNumberExposure(pool: Pool, numberId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT expose_groups_in_mcp FROM whatsapp_numbers WHERE id = $1`,
    [numberId],
  );
  return rows[0]?.expose_groups_in_mcp === true;
}

/** Reuse listThreads' group inference: known group JID or a message author. */
export async function isGroupThread(pool: Pool, numberId: number, identifier: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT (EXISTS (SELECT 1 FROM whatsapp_groups WHERE whatsapp_number_id = $1 AND jid = $2)
          OR EXISTS (SELECT 1 FROM messages WHERE whatsapp_number_id = $1 AND identifier = $2 AND author IS NOT NULL)) AS is_group`,
    [numberId, identifier],
  );
  return rows[0]?.is_group === true;
}
