import type { Pool, PoolClient } from 'pg';

/** Motivos de perda selecionáveis no dropdown — constantes hardcoded, SEM row em
 *  whatsapp_loss_reasons (migration 051, spec §3.2). */
export const SYSTEM_LOSS_REASONS = [
  { code: 'lead_nao_respondeu', label: 'Lead não respondeu' },
  { code: 'atendente_nao_respondeu', label: 'Atendente não respondeu' },
] as const;

/** Código EXCLUSIVO da cascata automática (ex.: is_lead vira false) — nunca aceito
 *  vindo de fora (POST, ou qualquer valor gravado manualmente em loss_reason). */
export const CASCADE_LOSS_REASON = 'nao_lead';

const SYSTEM_CODES = new Set<string>(SYSTEM_LOSS_REASONS.map(r => r.code));

/** Códigos que um motivo custom NUNCA pode colidir com (sistema + cascata). */
export const RESERVED_LOSS_REASON_CODES = new Set<string>([...SYSTEM_CODES, CASCADE_LOSS_REASON]);

export interface LossReason {
  id: number;
  code: string;
  label: string;
  description: string | null;
  active: boolean;
}

export interface CatalogLossReason extends LossReason {
  usageCount: number;
}

const mapLossReason = (row: any): LossReason => ({
  id: Number(row.id),
  code: row.code,
  label: row.label,
  description: row.description ?? null,
  active: row.active === true,
});

/**
 * Slugifica um label em código: lower → remove acentos → trim → sequências fora
 * de [a-z0-9] viram "_" → colapsa "_" repetidos → apara "_" nas bordas.
 * "Sem orçamento" → "sem_orcamento".
 */
export function slugifyLossCode(label: string): string {
  const withoutAccents = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return withoutAccents
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Motivos CUSTOM do workspace (catálogo em whatsapp_loss_reasons), com usageCount
 *  real. NÃO inclui os motivos de sistema — quem compõe a lista completa é a rota. */
export async function listLossReasons(pool: Pool, workspaceId: string): Promise<CatalogLossReason[]> {
  const { rows } = await pool.query(
    `SELECT r.id, r.code, r.label, r.description, r.active,
            COUNT(o.id)::int AS usage_count
       FROM whatsapp_loss_reasons r
       LEFT JOIN whatsapp_opportunities o
              ON o.workspace_id = r.workspace_id AND o.loss_reason = r.code
      WHERE r.workspace_id = $1
      GROUP BY r.id, r.code, r.label, r.description, r.active
      ORDER BY lower(r.label), r.id`,
    [workspaceId],
  );
  return rows.map((row: any) => ({ ...mapLossReason(row), usageCount: Number(row.usage_count) }));
}

/** usageCount por código (pensado pros 2 motivos de sistema, que não têm row própria). */
export async function countLossReasonUsage(
  pool: Pool,
  workspaceId: string,
  codes: readonly string[],
): Promise<Record<string, number>> {
  const usage: Record<string, number> = {};
  for (const code of codes) usage[code] = 0;
  if (codes.length === 0) return usage;
  const { rows } = await pool.query(
    `SELECT loss_reason AS code, COUNT(*)::int AS usage_count
       FROM whatsapp_opportunities
      WHERE workspace_id = $1 AND loss_reason = ANY($2::text[])
      GROUP BY loss_reason`,
    [workspaceId, codes],
  );
  for (const row of rows) usage[row.code] = Number(row.usage_count);
  return usage;
}

/**
 * true para: os 2 motivos de sistema, e qualquer custom ATIVO do workspace.
 * false para: CASCADE_LOSS_REASON ('nao_lead' — sempre, mesmo que exista row) e
 * qualquer código que não bata com nenhum dos anteriores (inativo, inexistente,
 * ou de outro workspace).
 */
// `db` aceita Pool OU PoolClient (Pick<PoolClient,'query'>): a validação é uma leitura
// workspace-scoped (não do par travado), então o aplicador do julgamento IA (D4) pode
// re-validar DENTRO do seu lock passando o `client` da transação — capturando um humano
// que desativou o motivo entre a montagem do snapshot e a aplicação.
export async function isValidLossReason(db: Pick<PoolClient, 'query'>, workspaceId: string, code: string): Promise<boolean> {
  if (code === CASCADE_LOSS_REASON) return false;
  if (SYSTEM_CODES.has(code)) return true;
  const { rows } = await db.query(
    `SELECT 1 FROM whatsapp_loss_reasons WHERE workspace_id = $1 AND code = $2 AND active = TRUE LIMIT 1`,
    [workspaceId, code],
  );
  return rows.length > 0;
}

export async function createLossReason(pool: Pool, p: {
  workspaceId: string;
  code: string;
  label: string;
  description?: string | null;
  createdBy?: string | null;
}): Promise<LossReason> {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_loss_reasons (workspace_id, code, label, description, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING id, code, label, description, active`,
    [p.workspaceId, p.code, p.label, p.description ?? null, p.createdBy ?? null],
  );
  return mapLossReason(rows[0]);
}

/** code NUNCA muda aqui — é referenciado por opps (loss_reason). */
export async function patchLossReason(pool: Pool, p: {
  id: number;
  workspaceId: string;
  label?: string;
  description?: string | null;
  active?: boolean;
  updatedBy?: string | null;
}): Promise<LossReason | null> {
  const values: unknown[] = [p.id, p.workspaceId];
  const set: string[] = [];
  if (p.label !== undefined) {
    values.push(p.label);
    set.push(`label=$${values.length}`);
  }
  if (p.description !== undefined) {
    values.push(p.description);
    set.push(`description=$${values.length}`);
  }
  if (p.active !== undefined) {
    values.push(p.active);
    set.push(`active=$${values.length}`);
  }
  values.push(p.updatedBy ?? null);
  set.push(`updated_by=$${values.length}`);
  set.push('updated_at=now()');
  const { rows } = await pool.query(
    `UPDATE whatsapp_loss_reasons SET ${set.join(', ')}
      WHERE id=$1 AND workspace_id=$2
      RETURNING id, code, label, description, active`,
    values,
  );
  return rows[0] ? mapLossReason(rows[0]) : null;
}

/** Soft-delete (active=false). Idempotente: aplicar de novo num já-inativo ainda
 *  retorna true (o id existe no workspace); só 404 quando o id não bate. */
export async function deleteLossReason(pool: Pool, p: {
  id: number;
  workspaceId: string;
  updatedBy?: string | null;
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE whatsapp_loss_reasons SET active=FALSE, updated_by=$3, updated_at=now()
      WHERE id=$1 AND workspace_id=$2
      RETURNING id`,
    [p.id, p.workspaceId, p.updatedBy ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}
