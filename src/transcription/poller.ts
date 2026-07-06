import { claimDueTranscriptionJobs } from '../db.js';
import { config } from '../config.js';
import { processJob, type ProcessDeps } from './service.js';
import { buildProcessDeps } from './runtime.js';

export async function runTranscriptionBatch(deps: ProcessDeps, batchSize: number): Promise<number> {
  const jobs = await claimDueTranscriptionJobs(batchSize);
  for (const job of jobs) await processJob(deps, job);
  return jobs.length;
}

export function startTranscriptionPoller(log: { info: (o: any, m?: string) => void; error: (o: any, m?: string) => void }): void {
  const deps = buildProcessDeps();
  const tick = async () => {
    try { await runTranscriptionBatch(deps, config.TRANSCRIBE_POLLER_BATCH_SIZE); }
    catch (err) { log.error({ err: (err as Error).message }, 'transcription poller tick falhou'); }
  };
  setInterval(tick, config.TRANSCRIBE_POLLER_INTERVAL_MS);
  log.info({ intervalMs: config.TRANSCRIBE_POLLER_INTERVAL_MS }, 'transcription poller iniciado');
}
