/**
 * src/meetings-summary/poller.ts
 *
 * Tick da fila de digest. Molde: src/transcription/poller.ts, sem o circuit
 * breaker — aqui o volume é ~20 reuniões/mês (contra milhares de áudios), então
 * a proteção contra apagão do provedor já está toda na política de retry
 * (`systemic` não consome tentativa, backoff de 15min). Um breaker por cima
 * seria mais peça para o mesmo efeito.
 */
import { claimDueSummaryJobs } from './db.js';
import { processSummaryJob, type ProcessSummaryDeps, type SummaryLogger } from './service.js';

/** Intervalo do tick. 20s dá o "imediatamente após a transcrição" pedido sem
 *  martelar o banco: a fila fica vazia quase o tempo todo e o claim é um índice
 *  parcial pequeno. Constante, não env — ninguém vai ajustar isso. */
export const POLL_INTERVAL_MS = 20_000;

/** Jobs por tick. Serial (um de cada vez), então o batch é só o teto do ciclo.
 *  3 é suficiente: o backfill de 253 drena em ~28min sem virar rajada na API. */
export const BATCH_SIZE = 3;

export async function runSummaryBatch(deps: ProcessSummaryDeps, batchSize = BATCH_SIZE): Promise<number> {
  const jobs = await claimDueSummaryJobs(batchSize);
  let done = 0;
  for (const job of jobs) {
    // Serial: uma falha não deve impedir o próximo job do batch, e o try/catch
    // não pode deixar o tick morrer — o job fica 'processing' e volta quando o
    // lease expirar (5min), que é exatamente o comportamento desejado.
    try {
      await processSummaryJob(deps, job);
      done += 1;
    } catch (err) {
      deps.log?.warn(
        { job: job.id, episode: job.episode_id, err: (err as Error).message },
        'meeting-summary: job lançou; volta quando o lease expirar',
      );
    }
  }
  return done;
}

export function startSummaryPoller(deps: ProcessSummaryDeps, log: SummaryLogger): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return; // tick anterior ainda drenando: não empilha
    running = true;
    try {
      await runSummaryBatch({ ...deps, log });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'meeting-summary: tick falhou');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  log.info({ intervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE, model: deps.llm.model }, 'meeting-summary poller iniciado');
  return timer;
}
