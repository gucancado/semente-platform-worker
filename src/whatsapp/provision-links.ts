import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';

export type LinkState = 'active' | 'consumed' | 'exhausted' | 'expired';

export type ProvisionLinkRow = {
  token: string;
  workspaceId: string;
  createdBy: string | null;
  maxClicks: number;
  clicksUsed: number;
  status: LinkState;
  consumedAt: string | null;
  connectedNumberId: number | null;
  createdAt: string;
  expiresAt: string;
};

function map(r: any): ProvisionLinkRow {
  return {
    token: r.token,
    workspaceId: r.workspace_id,
    createdBy: r.created_by,
    maxClicks: r.max_clicks,
    clicksUsed: r.clicks_used,
    status: r.status,
    consumedAt: r.consumed_at?.toISOString?.() ?? r.consumed_at ?? null,
    connectedNumberId: r.connected_number_id == null ? null : Number(r.connected_number_id),
    createdAt: r.created_at.toISOString?.() ?? r.created_at,
    expiresAt: r.expires_at.toISOString?.() ?? r.expires_at,
  };
}

export function generateLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Estado efetivo: TTL e esgotamento não mudam o status persistido até uma escrita, mas a leitura já os reflete. */
export function computeLinkState(row: ProvisionLinkRow, nowMs: number): LinkState {
  if (row.status !== 'active') return row.status;
  if (new Date(row.expiresAt).getTime() < nowMs) return 'expired';
  if (row.clicksUsed >= row.maxClicks) return 'exhausted';
  return 'active';
}

export async function createProvisionLink(
  pool: Pool,
  p: { token: string; workspaceId: string; createdBy: string | null; maxClicks: number; ttlDays: number },
): Promise<ProvisionLinkRow> {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_provision_links (token, workspace_id, created_by, max_clicks, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::interval)
     RETURNING *`,
    [p.token, p.workspaceId, p.createdBy, p.maxClicks, String(p.ttlDays)],
  );
  return map(rows[0]);
}

export async function getProvisionLink(pool: Pool, token: string): Promise<ProvisionLinkRow | null> {
  const { rows } = await pool.query(`SELECT * FROM whatsapp_provision_links WHERE token = $1`, [token]);
  return rows[0] ? map(rows[0]) : null;
}

/**
 * Consome 1 clique (geração de QR) de forma atômica. Revalida sob lock:
 * não expirado, ainda active, clicks < max. Ao atingir o max, marca 'exhausted'
 * (este clique ainda vale). Retorna workspaceId em caso de sucesso.
 */
export async function incrementLinkClick(
  pool: Pool,
  token: string,
): Promise<{ ok: true; workspaceId: string } | { ok: false; state: 'consumed' | 'exhausted' | 'expired' | 'not_found' }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM whatsapp_provision_links WHERE token = $1 FOR UPDATE`, [token]);
    if (!rows[0]) { await client.query('ROLLBACK'); return { ok: false, state: 'not_found' }; }
    const row = map(rows[0]);
    const state = computeLinkState(row, Date.now());
    if (state !== 'active') {
      // Persistir 'expired' se venceu por tempo (limpeza best-effort na leitura).
      if (state === 'expired' && row.status === 'active') {
        await client.query(`UPDATE whatsapp_provision_links SET status='expired' WHERE token=$1`, [token]);
      }
      await client.query('COMMIT');
      return { ok: false, state: state as 'consumed' | 'exhausted' | 'expired' };
    }
    const nextClicks = row.clicksUsed + 1;
    const nextStatus = nextClicks >= row.maxClicks ? 'exhausted' : 'active';
    await client.query(
      `UPDATE whatsapp_provision_links SET clicks_used = $2, status = $3 WHERE token = $1`,
      [token, nextClicks, nextStatus],
    );
    await client.query('COMMIT');
    return { ok: true, workspaceId: row.workspaceId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {}); // não mascara o erro original se o próprio ROLLBACK falhar
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Reembolsa 1 clique quando a geração do QR falha DEPOIS do incremento (ex.: Evolution
 * fora do ar) — senão uma janela de instabilidade queima o orçamento sem o cliente ver QR.
 * Reverte 'exhausted' → 'active' se aplicável; nunca ressuscita 'consumed'.
 */
export async function refundLinkClick(pool: Pool, token: string): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_provision_links
       SET clicks_used = GREATEST(clicks_used - 1, 0),
           status = CASE WHEN status = 'exhausted' THEN 'active' ELSE status END
     WHERE token = $1 AND status <> 'consumed' AND clicks_used > 0`,
    [token],
  );
}

/**
 * Marca 'consumed' quando um número conecta pelo link. Idempotente (só se ainda não consumido).
 * Respeita a expiração por TEMPO (expires_at >= NOW): um link vencido não vira 'consumed' — a
 * expiração vence, conforme a regra "morre no primeiro de consumed/exhausted/7 dias".
 */
export async function markLinkConsumed(pool: Pool, token: string, numberId: number): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_provision_links
       SET status='consumed', consumed_at=NOW(), connected_number_id=$2
     WHERE token=$1 AND status <> 'consumed' AND expires_at >= NOW()`,
    [token, numberId],
  );
}
