import type { Pool } from 'pg';
import { config } from '../config.js';
import { cloudPhoneNumberIdForAgent, sendCloudTemplate, sendCloudText } from '../webhook-cloud/send.js';
import { parseSlots } from './digest.js';
import { makeBatchSender, startOpsFlusher, type FlusherLog } from './flusher.js';

const LEASE_MIN = 10;
const BATCH_LIMIT = 50;

/**
 * Sobe o flusher a partir do config. Config incompleta NÃO derruba o worker:
 * loga em erro e não inicia (a fila acumula e sai quando a config voltar).
 */
export function startOpsFlusherFromConfig(pool: Pool, log: FlusherLog): NodeJS.Timeout | null {
  const to = config.OPS_NOTIFY_TO;
  const phoneNumberId = cloudPhoneNumberIdForAgent(
    config.WHATSAPP_CLOUD_NUMBERS_JSON as Record<string, { agent: string; project: string }>,
    config.CONNECTION_NOTIFY_CLOUD_AGENT,
  );
  if (!to || !phoneNumberId || !config.WHATSAPP_CLOUD_ACCESS_TOKEN) {
    log.error(
      { to: Boolean(to), phoneNumberId: Boolean(phoneNumberId), cloud: Boolean(config.WHATSAPP_CLOUD_ACCESS_TOKEN) },
      'ops-notify: flusher NÃO iniciado — config incompleta (avisos ficam na fila)',
    );
    return null;
  }
  const { slots, invalid } = parseSlots(config.OPS_DIGEST_SLOTS);
  if (invalid.length > 0) log.warn({ invalid }, 'ops-notify: OPS_DIGEST_SLOTS tem entrada inválida (esperado HH:mm) — ignorada');
  if (slots.length === 0) log.warn({}, 'ops-notify: sem horário de resumo — avisos "resumo" só saem junto com um urgente');

  return startOpsFlusher({
    pool,
    log,
    now: () => new Date(),
    slots,
    urgentWindowMs: config.OPS_URGENT_WINDOW_MIN * 60_000,
    leaseMin: LEASE_MIN,
    batchLimit: BATCH_LIMIT,
    send: makeBatchSender({ phoneNumberId, to, sendTemplate: sendCloudTemplate, sendText: sendCloudText }),
  });
}
