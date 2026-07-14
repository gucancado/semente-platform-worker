import { config } from '../config.js';
import { listActiveCollectedMeetings } from './db.js';
import { processCollectedMeeting, type MeetingsCollectDeps } from './service.js';
import { buildMeetingsCollectDeps } from './runtime.js';

export type { MeetingsCollectDeps } from './service.js';

export async function runMeetingsCollectBatch(deps: MeetingsCollectDeps): Promise<number> {
  const rows = await listActiveCollectedMeetings(deps.pool);
  for (const row of rows) {
    try {
      await processCollectedMeeting(deps, row);
    } catch (err) {
      deps.log?.warn?.({ id: row.id, err: (err as Error).message }, 'processCollectedMeeting falhou');
    }
  }
  return rows.length;
}

export function startMeetingsCollectPoller(log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }): void {
  const deps = buildMeetingsCollectDeps();
  const tick = async () => {
    try { await runMeetingsCollectBatch(deps); }
    catch (err) { log.error({ err: (err as Error).message }, 'meetings-collect poller tick falhou'); }
  };
  setInterval(tick, config.MEETINGS_COLLECT_POLLER_INTERVAL_MS);
  log.info({ intervalMs: config.MEETINGS_COLLECT_POLLER_INTERVAL_MS }, 'meetings-collect poller iniciado');
}
