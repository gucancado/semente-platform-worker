import type { Pool } from 'pg';
import { getNumberByInstance } from './numbers.js';

export async function resolveIngest(pool: Pool, instance: string, opts: { legacyEnabled: boolean; legacyParse: (i: string) => { agent: string; project: string | null } }) {
  const n = await getNumberByInstance(pool, instance);
  if (n) return { numberId: n.id, workspaceId: n.workspaceId, mode: n.mode, source: 'number' as const };
  if (!opts.legacyEnabled) return { numberId: null, workspaceId: null, mode: null, source: 'miss' as const };
  const { agent } = opts.legacyParse(instance);
  const { rows } = await pool.query(`SELECT workspace_id FROM contact_routes WHERE agent=$1 LIMIT 1`, [agent]);
  const workspaceId = rows[0]?.workspace_id ?? null;
  return { numberId: null, workspaceId, mode: null, source: 'legacy' as const };
}
