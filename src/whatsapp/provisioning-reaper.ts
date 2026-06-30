import type { Pool } from 'pg';
import type { EvolutionDeps } from '../evolution/client.js';
import { logoutInstance, deleteInstance } from '../evolution/client.js';
import { listExpiredProvisioning, deleteProvisioning } from './provisioning.js';

export type ReapDeps = { pool: Pool; evolution: EvolutionDeps };
type Logger = { warn: (...a: any[]) => void; info: (...a: any[]) => void };

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;

export async function reapExpiredProvisioning(deps: ReapDeps, logger?: Logger): Promise<{ checked: number; reaped: number }> {
  const rows = await listExpiredProvisioning(deps.pool, 200);
  let reaped = 0;
  for (const r of rows) {
    try {
      await logoutInstance(deps.evolution, r.evolutionInstance);
      await deleteInstance(deps.evolution, r.evolutionInstance);
    } catch (e) {
      logger?.warn?.({ err: (e as Error).message, instance: r.evolutionInstance }, 'reaper: Evolution delete falhou (segue dropando staging)');
    }
    await deleteProvisioning(deps.pool, r.evolutionInstance);
    reaped++;
  }
  return { checked: rows.length, reaped };
}

export function startProvisioningReaperCron(logger: Logger, deps: ReapDeps, intervalMs: number = DEFAULT_INTERVAL_MS): () => void {
  const tick = async () => {
    try {
      const out = await reapExpiredProvisioning(deps, logger);
      if (out.reaped > 0) logger.info({ op: 'provisioning-reaper', ...out }, 'provisioning reaper tick');
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'provisioning-reaper tick failed');
    }
  };
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}
