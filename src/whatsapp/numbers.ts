import type { Pool } from 'pg';

export type WhatsappNumber = {
  id: number; workspaceId: string; phone: string | null; evolutionInstance: string;
  label: string | null; status: 'pending'|'connecting'|'connected'|'disconnected';
  mode: 'monitored'|'agent_operated'; exposeGroupsInMcp: boolean;
  createdBy: string | null; createdAt: string; updatedAt: string;
  removedAt: string | null;
};

const SELECT = `SELECT id, workspace_id, phone, evolution_instance, label, status, mode,
  expose_groups_in_mcp, created_by, created_at, updated_at, removed_at FROM whatsapp_numbers`;

function map(r: any): WhatsappNumber {
  return { id: Number(r.id), workspaceId: r.workspace_id, phone: r.phone, evolutionInstance: r.evolution_instance,
    label: r.label, status: r.status, mode: r.mode, exposeGroupsInMcp: r.expose_groups_in_mcp === true,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString?.() ?? r.created_at, updatedAt: r.updated_at.toISOString?.() ?? r.updated_at,
    removedAt: r.removed_at ? (r.removed_at.toISOString?.() ?? r.removed_at) : null };
}

export async function createNumber(pool: Pool, p: { workspaceId: string; evolutionInstance: string; label: string | null; createdBy: string | null }) {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, label, created_by)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [p.workspaceId, p.evolutionInstance, p.label, p.createdBy]);
  return map(rows[0]);
}
export async function getNumberByInstance(pool: Pool, instance: string) {
  const { rows } = await pool.query(`${SELECT} WHERE evolution_instance = $1`, [instance]);
  return rows[0] ? map(rows[0]) : null;
}
export async function getNumber(pool: Pool, id: number) {
  const { rows } = await pool.query(`${SELECT} WHERE id = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}
export async function listNumbers(pool: Pool, workspaceId: string, opts?: { includeRemoved?: boolean }) {
  const where = opts?.includeRemoved
    ? `WHERE workspace_id = $1`
    : `WHERE workspace_id = $1 AND removed_at IS NULL`;
  const { rows } = await pool.query(`${SELECT} ${where} ORDER BY created_at DESC`, [workspaceId]);
  return rows.map(map);
}
export async function upsertConnectedNumber(
  pool: Pool,
  p: { workspaceId: string; evolutionInstance: string; phone: string | undefined; createdBy: string | null },
): Promise<WhatsappNumber> {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, phone, status, created_by)
     VALUES ($1, $2, $3, 'connected', $4)
     ON CONFLICT (evolution_instance) DO UPDATE
       SET status = 'connected',
           phone = COALESCE(EXCLUDED.phone, whatsapp_numbers.phone),
           updated_at = NOW()
     RETURNING *`,
    [p.workspaceId, p.evolutionInstance, p.phone ?? null, p.createdBy],
  );
  return map(rows[0]);
}
export async function renameNumberLabel(pool: Pool, id: number, label: string | null): Promise<void> {
  await pool.query(`UPDATE whatsapp_numbers SET label = $2, updated_at = NOW() WHERE id = $1`, [id, label]);
}
export async function updateNumberStatus(pool: Pool, instance: string, p: { status: WhatsappNumber['status']; phone?: string }) {
  await pool.query(
    `UPDATE whatsapp_numbers SET status = $2, phone = COALESCE($3, phone), updated_at = NOW() WHERE evolution_instance = $1`,
    [instance, p.status, p.phone ?? null]);
}

export function normalizePhone(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = (raw.split('@')[0] ?? '').split(':')[0]?.replace(/\D/g, '') ?? '';
  return digits ? `+${digits}` : undefined;
}

export async function setNumberLifecycle(pool: Pool, id: number, p: { status: WhatsappNumber['status']; removed: boolean }) {
  await pool.query(
    `UPDATE whatsapp_numbers
        SET status = $2, removed_at = CASE WHEN $3 THEN NOW() ELSE NULL END, updated_at = NOW()
      WHERE id = $1`,
    [id, p.status, p.removed],
  );
}

export async function reviveByWorkspacePhone(
  pool: Pool,
  p: { workspaceId: string; phone: string; evolutionInstance: string },
): Promise<{ number: WhatsappNumber; oldInstance: string } | null> {
  const { rows } = await pool.query(
    `WITH old AS (
       SELECT id, evolution_instance FROM whatsapp_numbers
        WHERE workspace_id = $1 AND phone = $2 AND (removed_at IS NOT NULL OR status <> 'connected')
        ORDER BY removed_at DESC NULLS LAST, updated_at DESC
        LIMIT 1
     )
     UPDATE whatsapp_numbers n
        SET status = 'connected', evolution_instance = $3, phone = $2, removed_at = NULL, updated_at = NOW()
       FROM old WHERE n.id = old.id
     RETURNING n.id, n.workspace_id, n.phone, n.evolution_instance, n.label, n.status, n.mode,
               n.expose_groups_in_mcp, n.created_by, n.created_at, n.updated_at, n.removed_at,
               old.evolution_instance AS old_instance`,
    [p.workspaceId, p.phone, p.evolutionInstance],
  );
  if (!rows[0]) return null;
  const oldInstance = rows[0].old_instance as string;
  return { number: map(rows[0]), oldInstance };
}
