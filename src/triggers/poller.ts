import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import {
  claimDuePendingTriggers,
  markTriggerFired,
  markTriggerRetryOrFail,
  type PendingTrigger,
} from '../db.js';

/**
 * Dispara um trigger HTTP no endpoint do mercurio (ou outro agente).
 * Marca status no DB conforme resultado: 'fired' em sucesso, 'pending' com
 * backoff em falha retryable, 'failed' após esgotar tentativas.
 */
async function fireTrigger(row: PendingTrigger, log: FastifyBaseLogger): Promise<void> {
  const agentCfg = config.AGENT_TOKENS_JSON[row.agent];
  if (!agentCfg?.trigger_url) {
    // Config sumiu entre enfileirar e disparar — marca failed permanente.
    await markTriggerRetryOrFail(row.id, config.TRIGGER_POLLER_MAX_ATTEMPTS, config.TRIGGER_POLLER_MAX_ATTEMPTS, 'no trigger_url configured');
    log.warn({ id: row.id, agent: row.agent }, 'poller: trigger_url sumiu — marcando failed');
    return;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (agentCfg.trigger_secret) headers['X-Trigger-Secret'] = agentCfg.trigger_secret;

  try {
    const r = await fetch(agentCfg.trigger_url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ inbox_id: row.last_inbox_id, agent: row.agent }),
      signal: AbortSignal.timeout(5_000),
    });
    if (r.ok) {
      await markTriggerFired(row.id);
      log.info(
        {
          id: row.id,
          agent: row.agent,
          identifier: row.identifier,
          msg_count: row.msg_count,
          attempt: row.attempt_count,
        },
        'poller: trigger fired'
      );
    } else {
      const result = await markTriggerRetryOrFail(
        row.id,
        row.attempt_count,
        config.TRIGGER_POLLER_MAX_ATTEMPTS,
        `status ${r.status}`
      );
      log.warn(
        { id: row.id, agent: row.agent, status: r.status, retried: result.retried },
        'poller: trigger non-ok'
      );
    }
  } catch (err) {
    const errMsg = (err as Error).message;
    const result = await markTriggerRetryOrFail(
      row.id,
      row.attempt_count,
      config.TRIGGER_POLLER_MAX_ATTEMPTS,
      errMsg
    );
    log.warn(
      { id: row.id, agent: row.agent, err: errMsg, retried: result.retried },
      'poller: trigger fetch falhou'
    );
  }
}

/**
 * Inicia o poller em loop. Roda 1 ciclo a cada TRIGGER_POLLER_INTERVAL_MS.
 * Dispara triggers em paralelo dentro de cada ciclo.
 *
 * Retorna handle do interval pra permitir shutdown limpo se necessário.
 */
export function startTriggerPoller(log: FastifyBaseLogger): NodeJS.Timeout {
  log.info(
    {
      interval_ms: config.TRIGGER_POLLER_INTERVAL_MS,
      batch_size: config.TRIGGER_POLLER_BATCH_SIZE,
      max_attempts: config.TRIGGER_POLLER_MAX_ATTEMPTS,
    },
    'trigger poller iniciado'
  );

  let running = false;
  const handle = setInterval(async () => {
    if (running) return; // skip ciclo se o anterior ainda está rodando
    running = true;
    try {
      const due = await claimDuePendingTriggers(config.TRIGGER_POLLER_BATCH_SIZE);
      if (due.length === 0) return;
      log.debug({ count: due.length }, 'poller: triggers claimed');
      await Promise.all(due.map((row) => fireTrigger(row, log)));
    } catch (err) {
      log.error({ err: (err as Error).message }, 'poller: ciclo falhou');
    } finally {
      running = false;
    }
  }, config.TRIGGER_POLLER_INTERVAL_MS);

  return handle;
}
