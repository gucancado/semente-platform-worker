import type { Pool } from 'pg';

export type WhatsappNumber = {
  id: number; workspaceId: string; phone: string | null; evolutionInstance: string;
  label: string | null; status: 'pending'|'connecting'|'connected'|'disconnected';
  mode: 'monitored'|'agent_operated'; exposeGroupsInMcp: boolean;
  createdBy: string | null; createdAt: string; updatedAt: string;
  removedAt: string | null;
};

export type StatusTransition = {
  numberId: number; workspaceId: string; phone: string | null; label: string | null;
  oldStatus: WhatsappNumber['status']; newStatus: WhatsappNumber['status'];
  wasAlerted: boolean;
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
           removed_at = NULL,
           updated_at = NOW()
     RETURNING *`,
    [p.workspaceId, p.evolutionInstance, p.phone ?? null, p.createdBy],
  );
  return map(rows[0]);
}
export async function renameNumberLabel(pool: Pool, id: number, label: string | null): Promise<void> {
  await pool.query(`UPDATE whatsapp_numbers SET label = $2, updated_at = NOW() WHERE id = $1`, [id, label]);
}
export async function updateNumberStatus(
  pool: Pool, instance: string, p: { status: WhatsappNumber['status']; phone?: string },
): Promise<StatusTransition | null> {
  const { rows } = await pool.query(
    `WITH prev AS (
       SELECT id, status AS old_status, alerted_at AS old_alerted_at
         FROM whatsapp_numbers WHERE evolution_instance = $1 FOR UPDATE
     )
     UPDATE whatsapp_numbers wn SET
       status = $2,
       phone = COALESCE($3, wn.phone),
       updated_at = NOW(),
       -- Reconectar um número REMOVIDO o traz de volta (invariante: connected ⟹ not removed).
       -- Só 'removido pelo botão' (removed_at) some da nav; desconectar (removed_at NULL) permanece.
       removed_at = CASE WHEN $2 = 'connected' THEN NULL ELSE wn.removed_at END,
       disconnected_since = CASE
         WHEN $2 = 'connected' THEN NULL
         WHEN prev.old_status = 'connected' THEN NOW()
         ELSE wn.disconnected_since END,
       alerted_at = CASE WHEN $2 = 'connected' THEN NULL ELSE wn.alerted_at END
     FROM prev
     WHERE wn.id = prev.id
     RETURNING wn.id AS number_id, wn.workspace_id, wn.phone, wn.label,
               prev.old_status, wn.status AS new_status,
               (prev.old_alerted_at IS NOT NULL) AS was_alerted`,
    [instance, p.status, p.phone ?? null]);
  const r = rows[0];
  if (!r) return null;
  return {
    numberId: Number(r.number_id), workspaceId: r.workspace_id, phone: r.phone, label: r.label,
    oldStatus: r.old_status, newStatus: r.new_status, wasAlerted: r.was_alerted === true,
  };
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

export type ClaimResult =
  | { kind: 'insert' }
  | { kind: 'blocked'; currentWorkspaceId: string }
  | { kind: 'moved'; number: WhatsappNumber; oldInstance: string };

// Tabelas com (referência ao número + workspace_id) que precisam re-carimbo na move.
// Confirmado por varredura das migrations. whatsapp_access_log usa 'number_id'.
const RESTAMP: ReadonlyArray<readonly [string, string]> = [
  ['messages', 'whatsapp_number_id'],
  ['webhook_logs', 'whatsapp_number_id'],
  ['transcription_jobs', 'whatsapp_number_id'],
  ['whatsapp_groups', 'whatsapp_number_id'],
  ['whatsapp_access_log', 'number_id'],
];

export async function claimNumberByPhone(
  pool: Pool,
  p: { phone: string; newWorkspaceId: string; evolutionInstance: string },
): Promise<ClaimResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT id, workspace_id, status, removed_at, evolution_instance
         FROM whatsapp_numbers WHERE phone = $1 FOR UPDATE`,
      [p.phone],
    );
    if (!sel.rows[0]) { await client.query('COMMIT'); return { kind: 'insert' }; }
    const row = sel.rows[0];
    const active = row.status === 'connected' && row.removed_at == null;
    if (active && row.workspace_id !== p.newWorkspaceId) {
      await client.query('COMMIT');
      return { kind: 'blocked', currentWorkspaceId: row.workspace_id };
    }
    const id = Number(row.id);
    for (const [table, col] of RESTAMP) {
      await client.query(`UPDATE ${table} SET workspace_id = $1 WHERE ${col} = $2`, [p.newWorkspaceId, id]);
    }
    const upd = await client.query(
      `UPDATE whatsapp_numbers
          SET workspace_id = $1, status = 'connected', evolution_instance = $2, phone = $3, removed_at = NULL, updated_at = NOW()
        WHERE id = $4
        RETURNING id, workspace_id, phone, evolution_instance, label, status, mode,
                  expose_groups_in_mcp, created_by, created_at, updated_at, removed_at`,
      [p.newWorkspaceId, p.evolutionInstance, p.phone, id],
    );
    await client.query('COMMIT');
    return { kind: 'moved', number: map(upd.rows[0]), oldInstance: row.evolution_instance };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
