import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { signEvent } from './signature.js';
import {
  expandPendingEvents, claimDueDeliveries, markDeliveryDelivered,
  markDeliveryRetryOrDead, type ClaimedDelivery,
} from './outbox.js';

async function deliver(row: ClaimedDelivery, log: FastifyBaseLogger): Promise<void> {
  const sub = config.EVENT_SUBSCRIBERS_JSON[row.event_type]?.[row.subscriber_key];
  if (!sub) {
    // assinante removido da config após expansão — dead permanente
    await markDeliveryRetryOrDead(row.id, config.OUTBOX_MAX_ATTEMPTS, config.OUTBOX_MAX_ATTEMPTS, 'assinante removido da config');
    return;
  }
  const body = JSON.stringify(row.payload);
  const timestamp = new Date().toISOString();
  try {
    const r = await fetch(sub.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Event-Id': String(row.event_id),
        'X-Delivery-Id': String(row.id),
        'X-Event-Timestamp': timestamp,
        'X-Semente-Signature': signEvent(sub.secrets[0]!, String(row.event_id), timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) {
      await markDeliveryDelivered(row.id);
      log.info({ delivery: row.id, event: row.event_id, sub: row.subscriber_key }, 'outbox: entrega ok');
    } else {
      const { dead } = await markDeliveryRetryOrDead(row.id, row.attempt_count, config.OUTBOX_MAX_ATTEMPTS, `status ${r.status}`);
      log.warn({ delivery: row.id, status: r.status, dead }, 'outbox: entrega non-ok');
    }
  } catch (err) {
    const { dead } = await markDeliveryRetryOrDead(row.id, row.attempt_count, config.OUTBOX_MAX_ATTEMPTS, (err as Error).message);
    log.warn({ delivery: row.id, err: (err as Error).message, dead }, 'outbox: entrega falhou');
  }
}

export function startOutboxDispatcher(log: FastifyBaseLogger): NodeJS.Timeout {
  log.info({ interval_ms: config.OUTBOX_POLLER_INTERVAL_MS }, 'outbox dispatcher iniciado');
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await expandPendingEvents(config.EVENT_SUBSCRIBERS_JSON, config.OUTBOX_POLLER_BATCH_SIZE);
      const due = await claimDueDeliveries(config.OUTBOX_POLLER_BATCH_SIZE);
      // allSettled: falha de DB num deliver não pode abortar o tratamento das demais entregas do ciclo
      if (due.length) await Promise.allSettled(due.map((d) => deliver(d, log)));
    } catch (err) {
      log.error({ err: (err as Error).message }, 'outbox: ciclo falhou');
    } finally {
      running = false;
    }
  }, config.OUTBOX_POLLER_INTERVAL_MS);
}
