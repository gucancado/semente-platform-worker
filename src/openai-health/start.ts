import type { Pool } from 'pg';
import { config } from '../config.js';
import { enqueueOps } from '../ops-notify/queue.js';
import { makeOpenAIProbe, runHealthTick } from './service.js';

/** Sobe a sonda. `OPENAI_HEALTH_INTERVAL_MIN=0` desliga; sem chave não há o que sondar. */
export function startOpenAIHealth(
  pool: Pool,
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void },
): void {
  const min = config.OPENAI_HEALTH_INTERVAL_MIN;
  if (!config.OPENAI_API_KEY || min <= 0) {
    log.info({ min, key: Boolean(config.OPENAI_API_KEY) }, 'openai-health: sonda NÃO iniciada');
    return;
  }
  const deps = {
    pool,
    probe: makeOpenAIProbe(config.OPENAI_API_KEY),
    notify: async (n: { titulo: string; detalhe: string }) => {
      await enqueueOps(pool, { ...n, urgency: 'urgent', source: 'openai-health' });
    },
    log,
  };
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runHealthTick(deps); }
    catch (err) { log.error({ err: (err as Error).message }, 'openai-health: tick falhou'); }
    finally { running = false; }
  };
  setTimeout(tick, 15_000);
  setInterval(tick, min * 60_000);
  log.info({ min }, 'openai-health: sonda iniciada');
}
