import { claimDueTranscriptionJobs, releaseTranscriptionClaims } from '../db.js';
import { config } from '../config.js';
import { processJob, type ProcessDeps } from './service.js';
import { buildProcessDeps } from './runtime.js';
import { createCircuitBreaker } from './breaker.js';

export interface RunBatchOpts {
  /** Corta o batch no meio (breaker abriu). Sem isto, a primeira falha sistêmica
   *  abriria o breaker e os outros 19 jobs do batch ainda bateriam na API só pra
   *  tomar o mesmo erro — a pausa só valeria a partir do tick seguinte. */
  shouldStop?: () => boolean;
  /** Jobs claimados que o corte deixou sem processar. O claim JÁ somou +1 em
   *  attempts, então sem devolver a tentativa o breaker puniria justamente os
   *  jobs que ele protegeu. */
  onSkipped?: (jobIds: number[]) => Promise<void>;
}

export async function runTranscriptionBatch(
  deps: ProcessDeps,
  batchSize: number,
  opts: RunBatchOpts = {},
): Promise<number> {
  const jobs = await claimDueTranscriptionJobs(batchSize);
  let done = 0;
  for (let i = 0; i < jobs.length; i += 1) {
    if (opts.shouldStop?.()) {
      const skipped = jobs.slice(i).map((j) => j.id);
      if (skipped.length && opts.onSkipped) await opts.onSkipped(skipped);
      break;
    }
    await processJob(deps, jobs[i]!);
    done += 1;
  }
  return done;
}

export function startTranscriptionPoller(log: { info: (o: any, m?: string) => void; error: (o: any, m?: string) => void }): void {
  const breaker = createCircuitBreaker({ cooldownMs: config.TRANSCRIBE_SYSTEMIC_COOLDOWN_MS });
  const deps: ProcessDeps = {
    ...buildProcessDeps(),
    systemicMaxAgeH: config.TRANSCRIBE_SYSTEMIC_MAX_AGE_H,
    onSystemicFailure: (error) => {
      const first = !breaker.isOpen();
      breaker.trip(error);
      // Loga só na ABERTURA: um batch de 20 jobs falhando junto geraria 20 linhas
      // idênticas, e é justamente durante o incidente que o log precisa ser legível.
      if (first) {
        log.error(
          { error, cooldownMs: config.TRANSCRIBE_SYSTEMIC_COOLDOWN_MS, consecutive: breaker.state().consecutive },
          'transcription: falha SISTÊMICA do provedor — fila pausada (jobs preservados, sem consumir tentativa)',
        );
      }
    },
  };

  const tick = async () => {
    if (breaker.isOpen()) return; // pausado: nem claima, pra não bumpar scheduled_at à toa
    try {
      const n = await runTranscriptionBatch(deps, config.TRANSCRIBE_POLLER_BATCH_SIZE, {
        shouldStop: () => breaker.isOpen(),
        onSkipped: (ids) => releaseTranscriptionClaims(ids, Math.ceil(config.TRANSCRIBE_SYSTEMIC_COOLDOWN_MS / 1000)),
      });
      if (n > 0 && !breaker.isOpen()) {
        // Batch inteiro sem falha sistêmica = ambiente de volta.
        const s = breaker.state();
        if (s.consecutive > 0) {
          log.info({ apagoes: s.consecutive }, 'transcription: provedor respondendo de novo — fila retomada');
          breaker.recordSuccess();
        }
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'transcription poller tick falhou');
    }
  };
  setInterval(tick, config.TRANSCRIBE_POLLER_INTERVAL_MS);
  log.info(
    {
      intervalMs: config.TRANSCRIBE_POLLER_INTERVAL_MS,
      systemicCooldownMs: config.TRANSCRIBE_SYSTEMIC_COOLDOWN_MS,
      systemicMaxAgeH: config.TRANSCRIBE_SYSTEMIC_MAX_AGE_H,
    },
    'transcription poller iniciado',
  );
}
