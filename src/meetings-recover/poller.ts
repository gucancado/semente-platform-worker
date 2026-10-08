import { claimRecoveryJob } from './db.js';
import { processRecoveryJob, type RecoverDeps } from './service.js';
import { buildRecoverDeps } from './runtime.js';

export const POLL_INTERVAL_MS = 120_000;

/** Um job por vez: cada um são minutos de chamadas longas e a fila é curta. */
export async function runRecoveryTick(deps: RecoverDeps): Promise<boolean> {
  const job = await claimRecoveryJob(deps.pool);
  if (!job) return false;
  await processRecoveryJob(deps, job);
  return true;
}

export function startMeetingsRecoverPoller(
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void },
): void {
  const deps = buildRecoverDeps(log);
  let running = false;
  const tick = async () => {
    if (running) return; // um job pode passar de vários ciclos
    running = true;
    try {
      // Drena enquanto houver job vencido: depois de uma queda longa vêm vários.
      while (await runRecoveryTick(deps)) { /* próximo */ }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'meetings-recover: tick falhou');
    } finally {
      running = false;
    }
  };
  setInterval(tick, POLL_INTERVAL_MS);
  log.info({ intervalMs: POLL_INTERVAL_MS }, 'meetings-recover: poller iniciado');
}
