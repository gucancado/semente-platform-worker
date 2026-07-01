import type { Pool } from 'pg';
import { logAccess } from './access-log.js';

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

/**
 * S4: casa o texto contra os source signals ativos do workspace e, no 1º match,
 * grava lead_source no thread_meta SÓ SE ainda for null (nunca sobrescreve humano).
 * Retorna { source } se gravou, null caso contrário. Nunca lança (best-effort).
 */
export async function detectAndTagSource(
  pool: Pool,
  p: { workspaceId: string; numberId: number; identifier: string; text: string },
): Promise<{ source: string } | null> {
  const signals = await listSourceSignals(pool, { workspaceId: p.workspaceId });
  const m = matchSource(p.text, signals);
  if (!m) return null;
  const { rowCount } = await pool.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, lead_source, updated_by, updated_at)
     VALUES ($1, $2, $3, 'system:ingest', NOW())
     ON CONFLICT (whatsapp_number_id, identifier) DO UPDATE
       SET lead_source = COALESCE(whatsapp_thread_meta.lead_source, EXCLUDED.lead_source),
           updated_by  = CASE WHEN whatsapp_thread_meta.lead_source IS NULL THEN 'system:ingest' ELSE whatsapp_thread_meta.updated_by END,
           updated_at  = CASE WHEN whatsapp_thread_meta.lead_source IS NULL THEN NOW() ELSE whatsapp_thread_meta.updated_at END
     WHERE whatsapp_thread_meta.lead_source IS NULL`,
    [p.numberId, p.identifier, m.source],
  );
  // rowCount>0 = inseriu ou atualizou (setou source). Se já tinha source, o WHERE do DO UPDATE barra → rowCount 0.
  if (!rowCount) return null;
  logAccess(pool, { actor: 'system:ingest', action: 'auto_source', workspaceId: p.workspaceId, numberId: p.numberId, identifier: p.identifier, meta: { source: m.source, pattern: m.pattern } });
  return { source: m.source };
}
