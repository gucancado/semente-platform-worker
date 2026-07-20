import type { Pool } from 'pg';

export type ProvisioningRow = {
  evolutionInstance: string;
  workspaceId: string;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  blockedWorkspaceId: string | null;
  provisionLinkToken: string | null;
};

function map(r: any): ProvisioningRow {
  return {
    evolutionInstance: r.evolution_instance,
    workspaceId: r.workspace_id,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString?.() ?? r.created_at,
    expiresAt: r.expires_at.toISOString?.() ?? r.expires_at,
    blockedWorkspaceId: r.blocked_workspace_id ?? null,
    provisionLinkToken: r.provision_link_token ?? null,
  };
}

export async function createProvisioning(
  pool: Pool,
  p: { evolutionInstance: string; workspaceId: string; createdBy: string | null; ttlSeconds: number; provisionLinkToken?: string | null },
): Promise<ProvisioningRow> {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_provisioning (evolution_instance, workspace_id, created_by, expires_at, provision_link_token)
     VALUES ($1, $2, $3, NOW() + ($4 || ' seconds')::interval, $5)
     RETURNING *`,
    [p.evolutionInstance, p.workspaceId, p.createdBy, String(p.ttlSeconds), p.provisionLinkToken ?? null],
  );
  return map(rows[0]);
}

export async function getProvisioning(pool: Pool, instance: string): Promise<ProvisioningRow | null> {
  const { rows } = await pool.query(`SELECT * FROM whatsapp_provisioning WHERE evolution_instance = $1`, [instance]);
  return rows[0] ? map(rows[0]) : null;
}

export async function deleteProvisioning(pool: Pool, instance: string): Promise<void> {
  await pool.query(`DELETE FROM whatsapp_provisioning WHERE evolution_instance = $1`, [instance]);
}

export async function listExpiredProvisioning(pool: Pool, limit = 200): Promise<ProvisioningRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_provisioning WHERE expires_at < NOW() ORDER BY expires_at ASC LIMIT $1`,
    [limit],
  );
  return rows.map(map);
}

export async function markProvisioningBlocked(pool: Pool, instance: string, blockedWorkspaceId: string): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_provisioning SET blocked_workspace_id = $2 WHERE evolution_instance = $1`,
    [instance, blockedWorkspaceId],
  );
}
