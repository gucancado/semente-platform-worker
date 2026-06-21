import type { Pool } from 'pg';
import type { EvolutionDeps } from '../evolution/client.js';
import { fetchAllGroups } from '../evolution/client.js';
import { getNumber } from './numbers.js';

/** Busca subjects de grupo na Evolution e faz upsert por (whatsapp_number_id, jid). */
export async function syncGroupSubjects(
  pool: Pool,
  deps: EvolutionDeps,
  numberId: number
): Promise<{ synced: number }> {
  const num = await getNumber(pool, numberId);
  if (!num) return { synced: 0 };
  const groups = await fetchAllGroups(deps, num.evolutionInstance);
  let synced = 0;
  for (const g of groups) {
    if (!g.subject) continue;
    await pool.query(
      `INSERT INTO whatsapp_groups (jid, subject, whatsapp_number_id, workspace_id, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (whatsapp_number_id, jid) WHERE whatsapp_number_id IS NOT NULL
       DO UPDATE SET subject = EXCLUDED.subject, workspace_id = EXCLUDED.workspace_id, updated_at = NOW()`,
      [g.jid, g.subject, numberId, num.workspaceId]
    );
    synced++;
  }
  return { synced };
}

/** Debounce: só sincroniza se nenhum grupo do número foi atualizado nos últimos `minMinutes`. */
export async function syncGroupSubjectsDebounced(
  pool: Pool,
  deps: EvolutionDeps,
  numberId: number,
  minMinutes = 30
): Promise<void> {
  const { rows } = await pool.query<{ recent: boolean }>(
    `SELECT EXISTS(
        SELECT 1 FROM whatsapp_groups
         WHERE whatsapp_number_id = $1 AND updated_at > NOW() - ($2 || ' minutes')::interval
      ) AS recent`,
    [numberId, String(minMinutes)]
  );
  if (rows[0]?.recent) return;
  await syncGroupSubjects(pool, deps, numberId);
}
