/**
 * src/weekly-context/poller.ts — gera os resumos da semana "vencida" (core.dueWeekStart).
 *
 * A cada tick lista os workspaces com grupo vinculado que ainda não têm resumo da
 * semana e gera um por vez (serial: ~27 workspaces, ~5 s cada). Como a semana
 * vencida vira na segunda às 6h (SP), é aí que a frota inteira é gerada (tick de
 * 15 min → pronta entre 6h e ~6h20); no resto da semana o tick só pega workspace novo ou falha de mais de 1h.
 */
import { dueWeekStart } from './core.js';
import { listPendingWorkspaces } from './db.js';
import { generateWeeklyContext, type WeeklyContextDeps } from './service.js';

export const WEEKLY_CONTEXT_POLL_MS = 15 * 60_000;

export async function runWeeklyContextTick(deps: WeeklyContextDeps): Promise<number> {
  const week = dueWeekStart((deps.now ?? (() => new Date()))());
  const pending = await listPendingWorkspaces(deps.pool, week);
  let done = 0;
  for (const ws of pending) {
    try {
      await generateWeeklyContext(deps, ws, week, 'scheduler');
      done += 1;
    } catch (err) {
      deps.log?.warn({ workspaceId: ws, err: (err as Error).message }, 'weekly-context: workspace lançou');
    }
  }
  return done;
}

export function startWeeklyContextPoller(deps: WeeklyContextDeps): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await runWeeklyContextTick(deps);
      if (n > 0) deps.log?.info({ generated: n }, 'weekly-context: tick');
    } catch (err) {
      deps.log?.warn({ err: (err as Error).message }, 'weekly-context: tick falhou');
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 60_000); // primeiro tick 1 min após o boot
  return setInterval(tick, WEEKLY_CONTEXT_POLL_MS);
}
