import type { Pool } from 'pg';

export type DisqualifyReason = {
  code: string;
  label: string;
  active: boolean;
  sortOrder: number;
};

export async function listDisqualifyReasons(
  pool: Pool,
  { workspaceId, includeInactive }: { workspaceId: string; includeInactive?: boolean }
): Promise<DisqualifyReason[]> {
  const sql = `
    SELECT r.code, r.label, r.active, COALESCE(d.sort_order, 999) AS sort_order
      FROM whatsapp_disqualify_reasons r
      LEFT JOIN whatsapp_disqualify_reason_defaults d ON d.code = r.code
     WHERE r.workspace_id = $1
       ${includeInactive ? '' : 'AND r.active = TRUE'}
     ORDER BY COALESCE(d.sort_order, 999), r.code`;
  const { rows } = await pool.query(sql, [workspaceId]);
  return rows.map((r: any) => ({
    code: r.code,
    label: r.label,
    active: r.active === true,
    sortOrder: Number(r.sort_order),
  }));
}

export async function upsertDisqualifyReason(
  pool: Pool,
  { workspaceId, code, label, createdBy }: {
    workspaceId: string;
    code: string;
    label: string;
    createdBy?: string | null;
  }
): Promise<{ reactivated: boolean }> {
  const { rows } = await pool.query(
    `WITH prev AS (
       SELECT active AS prev_active
         FROM whatsapp_disqualify_reasons
        WHERE workspace_id = $1 AND code = $2
     )
     INSERT INTO whatsapp_disqualify_reasons (workspace_id, code, label, active, created_by)
     VALUES ($1, $2, $3, TRUE, $4)
     ON CONFLICT (workspace_id, code) DO UPDATE SET label = EXCLUDED.label, active = TRUE
     RETURNING (SELECT prev_active FROM prev) AS prev_active`,
    [workspaceId, code, label, createdBy ?? null]
  );
  const row = rows[0];
  if (!row) throw new Error('upsertDisqualifyReason: no row returned');
  // new row → prev_active NULL → reactivated false
  // already active → prev_active true → reactivated false
  // was inactive → prev_active false → reactivated true
  return { reactivated: row.prev_active === false };
}

export async function deactivateDisqualifyReason(
  pool: Pool,
  { workspaceId, code }: { workspaceId: string; code: string }
): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_disqualify_reasons SET active = FALSE
      WHERE workspace_id = $1 AND code = $2`,
    [workspaceId, code]
  );
}

export async function seedDefaultReasons(pool: Pool, workspaceId: string): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_disqualify_reasons (workspace_id, code, label, active)
     SELECT $1, d.code, d.label, TRUE
       FROM whatsapp_disqualify_reason_defaults d
     ON CONFLICT (workspace_id, code) DO NOTHING`,
    [workspaceId]
  );
}
