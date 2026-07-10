import type { Pool } from 'pg';
import { insertEventTx } from '../events/outbox.js';
import { config } from '../config.js';
import { sendText } from '../evolution/client.js';

export const CONNECTION_EVENT_TYPE = 'whatsapp_conexao_v1';

export type ConnectionEventPayload = {
  status: 'down' | 'resolved';
  workspaceId: string; numberId: number; phone: string | null; label: string | null;
  state: string; since: string | null;
};

/** Enfileira um evento de conexão no outbox (transação curta própria). */
export async function enqueueConnectionEvent(pool: Pool, payload: ConnectionEventPayload): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertEventTx(client, {
      event_type: CONNECTION_EVENT_TYPE,
      aggregate_type: 'whatsapp_number',
      aggregate_id: String(payload.numberId),
      payload,
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

type SweepRow = {
  id: number; workspace_id: string; phone: string | null; label: string | null;
  status: string; disconnected_since: string;
};

function pushText(r: SweepRow): string {
  const mins = Math.max(1, Math.round((Date.now() - new Date(r.disconnected_since).getTime()) / 60_000));
  return [
    '⚠️ WhatsApp caiu',
    '',
    `Número: ${r.label ?? '(sem rótulo)'} — ${r.phone ?? 's/ número'}`,
    `Workspace: ${r.workspace_id}`,
    `Estado: ${r.status} há ~${mins} min`,
    '',
    'Reconecte pelo painel: https://painel.beeads.com.br',
  ].join('\n');
}

/**
 * Varre números fora do ar (status<>connected) há mais que o debounce e ainda não
 * alertados. Carimba alerted_at (idempotência por episódio), enfileira evento 'down'
 * no outbox e, se sender+target configurados, envia o aviso por WhatsApp (Saturno).
 * Retorna o nº de alertas disparados.
 */
export async function sweepDisconnectionAlerts(
  pool: Pool,
  opts: { debounceMs: number; sender?: string; target?: string; evolution: { baseUrl: string; apiKey: string } },
): Promise<number> {
  // Carimbo (alerted_at) + enqueue no MESMO commit (outbox transacional): se o processo
  // morrer no meio, o ROLLBACK des-carimba E des-enfileira → o sweep reprocessa no próximo
  // ciclo. Separar as duas transações perderia o alerta 'down' silenciosamente (review #2).
  const client = await pool.connect();
  let rows: SweepRow[] = [];
  try {
    await client.query('BEGIN');
    const res = await client.query<SweepRow>(
      `UPDATE whatsapp_numbers
          SET alerted_at = NOW()
        WHERE status <> 'connected'
          AND removed_at IS NULL
          AND disconnected_since IS NOT NULL
          AND disconnected_since <= NOW() - ($1 || ' milliseconds')::interval
          AND alerted_at IS NULL
        RETURNING id, workspace_id, phone, label, status,
                  disconnected_since::text AS disconnected_since`,
      [String(opts.debounceMs)]);
    rows = res.rows;
    for (const r of rows) {
      await insertEventTx(client, {
        event_type: CONNECTION_EVENT_TYPE,
        aggregate_type: 'whatsapp_number',
        aggregate_id: String(r.id),
        payload: {
          status: 'down', workspaceId: r.workspace_id, numberId: Number(r.id),
          phone: r.phone, label: r.label, state: r.status, since: r.disconnected_since,
        },
      });
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Push WhatsApp best-effort APÓS o commit (at-most-once é aceitável pro push; o alerta
  // de painel — o canal confiável — já está durável no outbox).
  if (opts.sender && opts.target) {
    const to = opts.target.replace(/^\+/, '');
    for (const r of rows) {
      await sendText(opts.evolution, opts.sender, to, pushText(r))
        .catch((err) => console.error('[connection-alerts] push Saturno falhou:', (err as Error).message));
    }
  }
  return rows.length;
}

export function startConnectionAlertSweep(pool: Pool, log: { info: Function; error: Function }): NodeJS.Timeout {
  const evolution = { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY };
  if (!config.CONNECTION_ALERT_SENDER_INSTANCE || !config.CONNECTION_ALERT_TARGET) {
    log.info('connection-alert sweep: sender/target ausentes — só alerta de painel (sem push WhatsApp)');
  }
  log.info({ interval_ms: config.CONNECTION_ALERT_SWEEP_INTERVAL_MS, debounce_ms: config.CONNECTION_ALERT_DEBOUNCE_MS }, 'connection-alert sweep iniciado');
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepDisconnectionAlerts(pool, {
        debounceMs: config.CONNECTION_ALERT_DEBOUNCE_MS,
        sender: config.CONNECTION_ALERT_SENDER_INSTANCE,
        target: config.CONNECTION_ALERT_TARGET,
        evolution,
      });
    } catch (err) {
      log.error({ err: (err as Error).message }, 'connection-alert sweep: ciclo falhou');
    } finally {
      running = false;
    }
  }, config.CONNECTION_ALERT_SWEEP_INTERVAL_MS);
}
