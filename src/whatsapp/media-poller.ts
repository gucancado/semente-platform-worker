/**
 * src/whatsapp/media-poller.ts
 *
 * Fiação dos dois pollers da mídia do WhatsApp com env, Evolution e R2:
 *  - download: sobe com WHATSAPP_MEDIA_MODE=on;
 *  - expiração por idade: sobe com WHATSAPP_MEDIA_RETENTION_DAYS >= 30. Hoje 0 —
 *    DESLIGADA por decisão do owner (2026-09-16) até o uso passar de 70% do
 *    orçamento e ele aprovar.
 * A lógica mora em media-service, media-retention e media-policy.
 */
import type { Pool } from 'pg';
import { config } from '../config.js';
import { pool as defaultPool } from '../db.js';
import { getBase64FromMediaMessage } from '../evolution/client.js';
import { deleteObject, putAndVerify, whatsappMediaBucket } from '../integrations/r2.js';
import { createCircuitBreaker } from '../transcription/breaker.js';
import { claimDueWhatsappMediaJobs, releaseWhatsappMediaClaims } from './media-jobs.js';
import { retentionEnabled } from './media-policy.js';
import { processMediaJob, type MediaIo, type MediaProcessDeps } from './media-service.js';
import { sweepExpiredMedia, type RetentionIo } from './media-retention.js';

type Log = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
};

const SYSTEMIC_COOLDOWN_MS = 600_000;
const RETENTION_INTERVAL_MS = 3_600_000;

export function defaultMediaIo(): MediaIo {
  const evolution = { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY };
  const bucket = whatsappMediaBucket()!;
  return {
    download: (instance, envelope) => getBase64FromMediaMessage(evolution, instance, envelope),
    upload: (key, body, contentType) => putAndVerify(key, body, contentType, bucket),
  };
}

export function defaultRetentionIo(): RetentionIo {
  const bucket = whatsappMediaBucket()!;
  return { deleteObject: (key) => deleteObject(key, bucket) };
}

export function startWhatsappMediaPoller(log: Log, pool: Pool = defaultPool): void {
  const breaker = createCircuitBreaker({ cooldownMs: SYSTEMIC_COOLDOWN_MS });
  const deps: MediaProcessDeps = {
    pool,
    io: defaultMediaIo(),
    maxBytes: config.WHATSAPP_MEDIA_MAX_BYTES,
    maxAttempts: config.WHATSAPP_MEDIA_MAX_ATTEMPTS,
    log,
    onSystemicFailure: (error) => {
      const first = !breaker.isOpen();
      breaker.trip(error);
      // Loga só na ABERTURA: um batch falhando junto geraria N linhas idênticas.
      if (first) {
        log.error({ error, cooldownMs: SYSTEMIC_COOLDOWN_MS }, 'whatsapp-media: falha SISTÊMICA (Evolution ou R2) — fila pausada, jobs preservados');
      }
    },
  };

  // Um tick por vez: um documento de 16 MB chega como ~21 MB de base64 e pode levar
  // mais que o intervalo. Sem a trava, ticks sobrepostos baixariam em paralelo.
  let running = false;
  const tick = async () => {
    if (running || breaker.isOpen()) return;
    running = true;
    try {
      const jobs = await claimDueWhatsappMediaJobs(pool, config.WHATSAPP_MEDIA_POLLER_BATCH_SIZE);
      for (let i = 0; i < jobs.length; i += 1) {
        if (breaker.isOpen()) {
          await releaseWhatsappMediaClaims(pool, jobs.slice(i).map((j) => j.id), Math.ceil(SYSTEMIC_COOLDOWN_MS / 1000));
          break;
        }
        await processMediaJob(deps, jobs[i]!);
      }
      if (jobs.length > 0 && !breaker.isOpen() && breaker.state().consecutive > 0) {
        log.info({ apagoes: breaker.state().consecutive }, 'whatsapp-media: ambiente respondendo de novo — fila retomada');
        breaker.recordSuccess();
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'whatsapp-media: tick do poller falhou');
    } finally {
      running = false;
    }
  };
  setInterval(tick, config.WHATSAPP_MEDIA_POLLER_INTERVAL_MS);
  log.info(
    { intervalMs: config.WHATSAPP_MEDIA_POLLER_INTERVAL_MS, maxBytes: config.WHATSAPP_MEDIA_MAX_BYTES, kinds: config.WHATSAPP_MEDIA_KINDS },
    'whatsapp-media: poller de download iniciado',
  );
}

export function startMediaRetentionPoller(log: Log, pool: Pool = defaultPool): void {
  const days = config.WHATSAPP_MEDIA_RETENTION_DAYS;
  // Defesa em profundidade: index.ts já checa, mas este módulo não pode ser a
  // porta pra uma varredura com dias inválidos.
  if (!retentionEnabled(days)) {
    log.info({ days }, 'whatsapp-media: expiração DESLIGADA');
    return;
  }
  const io = defaultRetentionIo();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await sweepExpiredMedia(pool, io, { days, budget: config.WHATSAPP_MEDIA_RETENTION_BUDGET_PER_RUN });
      if (r.selected > 0) log.info({ days, ...r }, 'whatsapp-media: expiração por idade rodou');
    } catch (err) {
      log.error({ err: (err as Error).message }, 'whatsapp-media: expiração falhou');
    } finally {
      running = false;
    }
  };
  setInterval(tick, RETENTION_INTERVAL_MS);
  log.warn({ days, budgetPerRun: config.WHATSAPP_MEDIA_RETENTION_BUDGET_PER_RUN }, 'whatsapp-media: expiração por idade LIGADA');
}
