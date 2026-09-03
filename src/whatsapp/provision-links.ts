import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { normalizePhone } from './numbers.js';

export type LinkState = 'active' | 'consumed' | 'exhausted' | 'expired' | 'blocked';

export type ProvisionLinkRow = {
  token: string;
  /** NULL = instância de SISTEMA (ex.: saturno), que não pertence a workspace nenhum. */
  workspaceId: string | null;
  createdBy: string | null;
  maxClicks: number;
  clicksUsed: number;
  status: LinkState;
  consumedAt: string | null;
  connectedNumberId: number | null;
  /** Instância Evolution alvo. NULL = link de conexão nova (cria instância). */
  targetInstance: string | null;
  /** Só apresentação (título da página pública). NUNCA entra em autorização. */
  targetLabel: string | null;
  /** Trava de identidade: telefone (+E164) que o pareamento DEVE apresentar. */
  expectedPhone: string | null;
  createdAt: string;
  expiresAt: string;
};

function map(r: any): ProvisionLinkRow {
  return {
    token: r.token,
    workspaceId: r.workspace_id ?? null,
    createdBy: r.created_by,
    maxClicks: r.max_clicks,
    clicksUsed: r.clicks_used,
    status: r.status,
    consumedAt: r.consumed_at?.toISOString?.() ?? r.consumed_at ?? null,
    connectedNumberId: r.connected_number_id == null ? null : Number(r.connected_number_id),
    targetInstance: r.target_instance ?? null,
    targetLabel: r.target_label ?? null,
    expectedPhone: r.expected_phone ?? null,
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
): Promise<{ ok: true; workspaceId: string | null } | { ok: false; state: 'consumed' | 'exhausted' | 'expired' | 'not_found' }> {
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
 * 'blocked' também é terminal: é o veredito de pareamento com telefone errado e não pode
 * ser lavado por um consumo posterior (as rotas já barram antes; aqui é defesa em profundidade).
 * `numberId` nulo = reconexão — não há número novo a apontar.
 */
export async function markLinkConsumed(pool: Pool, token: string, numberId: number | null): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_provision_links
       SET status='consumed', consumed_at=NOW(), connected_number_id=$2
     WHERE token=$1 AND status NOT IN ('consumed','blocked') AND expires_at >= NOW()`,
    [token, numberId],
  );
}

/**
 * Link que RECONECTA uma instância existente (não cria nada). Emitir um novo
 * EXPIRA os ativos do mesmo alvo, no mesmo commit — no máximo um link vivo por
 * instância (spec §7.8), senão um link antigo vazado sobreviveria à reemissão.
 * `workspaceId` nulo = instância de sistema (saturno).
 */
export async function createReconnectLink(
  pool: Pool,
  p: {
    token: string; targetInstance: string; targetLabel: string | null; expectedPhone: string;
    workspaceId: string | null; createdBy: string | null; maxClicks: number; ttlDays: number;
  },
): Promise<ProvisionLinkRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE whatsapp_provision_links SET status='expired' WHERE target_instance = $1 AND status = 'active'`,
      [p.targetInstance],
    );
    const { rows } = await client.query(
      `INSERT INTO whatsapp_provision_links
         (token, workspace_id, created_by, max_clicks, expires_at, target_instance, target_label, expected_phone)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::interval, $6, $7, $8)
       RETURNING *`,
      [p.token, p.workspaceId, p.createdBy, p.maxClicks, String(p.ttlDays), p.targetInstance, p.targetLabel, p.expectedPhone],
    );
    await client.query('COMMIT');
    return map(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export type SettleResult =
  | { kind: 'none' }
  | { kind: 'skipped_no_phone' }
  | { kind: 'consumed'; count: number }
  | { kind: 'mismatch'; expectedPhone: string };

/**
 * Liquida os links de reconexão de uma instância que acabou de conectar.
 * Telefone divergente do esperado → bloqueia TODOS os ativos do alvo (o caller
 * derruba a sessão). Telefone certo → consome (é a regra "morre ao reconectar").
 * Sem telefone observável → não decide nada: bloquear aqui derrubaria uma
 * reconexão legítima por falha de parse do payload. Só banco — Evolution é do caller.
 */
export async function settleReconnectLinks(
  pool: Pool,
  instance: string,
  observedPhone: string | undefined,
): Promise<SettleResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM whatsapp_provision_links WHERE target_instance = $1 AND status = 'active' FOR UPDATE`,
      [instance],
    );
    if (rows.length === 0) { await client.query('COMMIT'); return { kind: 'none' }; }
    const observed = normalizePhone(observedPhone);
    if (!observed) { await client.query('COMMIT'); return { kind: 'skipped_no_phone' }; }
    const links = rows.map(map);
    const mismatched = links.find((l) => normalizePhone(l.expectedPhone) !== observed);
    if (mismatched) {
      await client.query(
        `UPDATE whatsapp_provision_links SET status='blocked' WHERE target_instance = $1 AND status = 'active'`,
        [instance],
      );
      await client.query('COMMIT');
      return { kind: 'mismatch', expectedPhone: mismatched.expectedPhone ?? '' };
    }
    await client.query(
      `UPDATE whatsapp_provision_links SET status='consumed', consumed_at=NOW() WHERE target_instance = $1 AND status = 'active'`,
      [instance],
    );
    await client.query('COMMIT');
    return { kind: 'consumed', count: links.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
