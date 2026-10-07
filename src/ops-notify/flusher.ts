import type { Pool } from 'pg';
import type { CloudSendResult, CloudTemplateMessage } from '../webhook-cloud/send.js';
import { OPS_ALERT_TEMPLATE, OPS_DIGEST_DETALHE_MAX, opsAlertTemplateParams, renderOpsAlertText } from '../webhook-cloud/templates.js';
import { formatBatch, planFlush, type Slot } from './digest.js';
import { claimBatch, markFailed, markSent, pendingSummary } from './queue.js';

/**
 * Envia a fila de avisos ao operador em LOTE (ver `digest.ts` para as regras).
 * Um tick por minuto: barato (uma query de agregado) e suficiente para a janela
 * de urgente, que é de minutos.
 */

export type FlusherLog = {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
  error: (o: object, m: string) => void;
};

export type FlusherDeps = {
  pool: Pool;
  log: FlusherLog;
  now: () => Date;
  slots: Slot[];
  urgentWindowMs: number;
  /** Lease do lote — também é o backoff depois de uma falha. */
  leaseMin: number;
  /** Teto de itens por mensagem; o resto sai no tick seguinte. */
  batchLimit: number;
  send: (titulo: string, detalhe: string) => Promise<{ ok: boolean; sendId: string | null; detail?: unknown }>;
};

export async function runOpsFlush(deps: FlusherDeps): Promise<'idle' | 'sent' | 'failed'> {
  const summary = await pendingSummary(deps.pool, deps.leaseMin);
  const decision = planFlush({ now: deps.now(), ...summary, slots: deps.slots, urgentWindowMs: deps.urgentWindowMs });
  if (!decision.flush) return 'idle';

  const batch = await claimBatch(deps.pool, deps.leaseMin, deps.batchLimit);
  if (batch.length === 0) return 'idle'; // outro container levou
  const ids = batch.map((b) => b.id);
  const msg = formatBatch(batch, decision);

  let r: { ok: boolean; sendId: string | null; detail?: unknown };
  try {
    r = await deps.send(msg.titulo, msg.detalhe);
  } catch (err) {
    r = { ok: false, sendId: null, detail: (err as Error).message };
  }
  if (r.ok) {
    await markSent(deps.pool, ids, r.sendId);
    deps.log.info({ reason: decision.reason, items: ids.length, send_id: r.sendId }, 'ops-notify: lote enviado');
    return 'sent';
  }
  await markFailed(deps.pool, ids, r.detail ?? null);
  deps.log.error({ reason: decision.reason, items: ids.length, detail: r.detail }, 'ops-notify: lote falhou — re-tenta quando o lease expirar');
  return 'failed';
}

/**
 * Template primeiro (só ele chega fora da janela de 24h), texto livre como
 * fallback — mesma escada de sempre, com o teto maior do detalhe de resumo.
 */
export function makeBatchSender(opts: {
  phoneNumberId: string;
  to: string;
  sendTemplate: (pnid: string, to: string, t: CloudTemplateMessage) => Promise<CloudSendResult>;
  sendText: (pnid: string, to: string, text: string) => Promise<CloudSendResult>;
}): FlusherDeps['send'] {
  const fmt = { detalheMax: OPS_DIGEST_DETALHE_MAX };
  return async (titulo, detalhe) => {
    const input = { titulo, detalhe };
    let templateFailure: unknown = null;
    try {
      const t = await opts.sendTemplate(opts.phoneNumberId, opts.to, {
        name: OPS_ALERT_TEMPLATE.name,
        language: OPS_ALERT_TEMPLATE.language,
        ...opsAlertTemplateParams(input, fmt),
      });
      if (t.ok) return { ok: true, sendId: t.send_id };
      templateFailure = { status: t.status, detail: t.detail };
    } catch (err) {
      templateFailure = (err as Error).message;
    }
    try {
      const x = await opts.sendText(opts.phoneNumberId, opts.to, renderOpsAlertText(input, fmt));
      if (x.ok) return { ok: true, sendId: x.send_id };
      return { ok: false, sendId: null, detail: { template: templateFailure, text: { status: x.status, detail: x.detail } } };
    } catch (err) {
      return { ok: false, sendId: null, detail: { template: templateFailure, text: (err as Error).message } };
    }
  };
}

const TICK_MS = 60_000;

export function startOpsFlusher(deps: FlusherDeps): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOpsFlush(deps);
    } catch (err) {
      deps.log.warn({ err: (err as Error).message }, 'ops-notify: tick do flusher falhou');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, TICK_MS);
  void tick();
  deps.log.info(
    {
      slots: deps.slots.map((s) => `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`),
      urgentWindowMin: deps.urgentWindowMs / 60_000,
    },
    'ops-notify: flusher iniciado',
  );
  return timer;
}
