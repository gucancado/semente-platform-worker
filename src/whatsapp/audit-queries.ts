/**
 * src/whatsapp/audit-queries.ts
 * Leitura do whatsapp_access_log (feed de auditoria LGPD). Workspace-scoped,
 * paginação keyset por id (BIGSERIAL, monotônico → sem bug µs/ms).
 */
import type { Pool } from 'pg';

/** Ações governança-relevantes (default do feed). `export` entra por ser exfiltração. */
export const RELEVANT_ACTIONS = [
  'set_lead', 'set_lead_bulk',
  'upsert_disqualify_reason', 'deactivate_disqualify_reason',
  'export',
] as const;

export type AccessLogEntry = {
  id: number;
  actor: string;
  action: string;
  numberId: number | null;
  identifier: string | null;
  createdAt: string;
  meta: Record<string, unknown> | null;
};

export async function listAccessLog(pool: Pool, p: {
  workspaceId: string;
  numberId?: number;
  actor?: string;
  actions?: string[];
  since?: string;
  until?: string;
  limit: number;
  cursor?: string;
}): Promise<{ entries: AccessLogEntry[]; nextCursor: string | null }> {
  // Guard: [] significaria ANY('{}') = nenhuma linha; tratar como "sem filtro".
  const actions = p.actions && p.actions.length > 0 ? p.actions : null;

  // $1=workspaceId $2=numberId $3=actor $4=actions[] $5=since $6=until $7=cursorId $8=limit
  const { rows } = await pool.query(
    `SELECT id, actor, action, number_id, identifier, created_at, meta
       FROM whatsapp_access_log
      WHERE workspace_id = $1
        AND ($2::bigint IS NULL OR number_id = $2)
        AND ($3::text   IS NULL OR actor = $3)
        AND ($4::text[] IS NULL OR action = ANY($4))
        AND ($5::timestamptz IS NULL OR created_at >= $5)
        AND ($6::timestamptz IS NULL OR created_at <= $6)
        AND ($7::bigint IS NULL OR id < $7)
      ORDER BY id DESC
      LIMIT $8`,
    [
      p.workspaceId,
      p.numberId ?? null,
      p.actor ?? null,
      actions,
      p.since ?? null,
      p.until ?? null,
      p.cursor ?? null,
      p.limit,
    ],
  );

  const entries: AccessLogEntry[] = rows.map(r => ({
    id: Number(r.id),
    actor: r.actor,
    action: r.action,
    numberId: r.number_id != null ? Number(r.number_id) : null,
    identifier: r.identifier ?? null,
    createdAt: r.created_at.toISOString(),
    meta: r.meta ?? null,
  }));

  const lastRow = rows[rows.length - 1];
  const nextCursor = rows.length === p.limit && lastRow ? String(lastRow.id) : null;
  return { entries, nextCursor };
}
