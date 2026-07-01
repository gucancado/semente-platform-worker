import type { Pool } from 'pg';

export type SourceSignal = { pattern: string; source: string; active: boolean; sortOrder: number };

/** Normaliza pra match: lowercase, remove diacríticos, trim, colapsa espaços. */
export function normalizePattern(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/\s+/g, ' ');
}

/** 1º signal ativo (por sortOrder) cujo pattern é substring do texto normalizado. */
export function matchSource(text: string, signals: SourceSignal[]): { source: string; pattern: string } | null {
  const norm = normalizePattern(text);
  const ordered = [...signals].filter(s => s.active).sort((a, b) => a.sortOrder - b.sortOrder);
  for (const s of ordered) {
    if (norm.includes(s.pattern)) return { source: s.source, pattern: s.pattern };
  }
  return null;
}

export async function listSourceSignals(
  pool: Pool, { workspaceId, includeInactive }: { workspaceId: string; includeInactive?: boolean },
): Promise<SourceSignal[]> {
  const { rows } = await pool.query(
    `SELECT pattern, source, active, sort_order
       FROM whatsapp_source_signals
      WHERE workspace_id = $1 ${includeInactive ? '' : 'AND active = TRUE'}
      ORDER BY sort_order, pattern`,
    [workspaceId],
  );
  return rows.map((r: any) => ({ pattern: r.pattern, source: r.source, active: r.active === true, sortOrder: Number(r.sort_order) }));
}

export async function upsertSourceSignal(
  pool: Pool, { workspaceId, pattern, source, sortOrder }: { workspaceId: string; pattern: string; source: string; sortOrder?: number },
): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_source_signals (workspace_id, pattern, source, active, sort_order)
     VALUES ($1, $2, $3, TRUE, $4)
     ON CONFLICT (workspace_id, pattern) DO UPDATE SET source = EXCLUDED.source, active = TRUE`,
    [workspaceId, normalizePattern(pattern), source, sortOrder ?? 100],
  );
}

export async function deactivateSourceSignal(
  pool: Pool, { workspaceId, pattern }: { workspaceId: string; pattern: string },
): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_source_signals SET active = FALSE WHERE workspace_id = $1 AND pattern = $2`,
    [workspaceId, normalizePattern(pattern)],
  );
}

export async function seedDefaultSourceSignals(pool: Pool, workspaceId: string): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_source_signals (workspace_id, pattern, source, active, sort_order)
     SELECT $1, d.pattern, d.source, TRUE, d.sort_order
       FROM whatsapp_source_signal_defaults d
     ON CONFLICT (workspace_id, pattern) DO NOTHING`,
    [workspaceId],
  );
}
