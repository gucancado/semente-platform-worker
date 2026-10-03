/**
 * src/meetings-collect/diagnostics.ts
 *
 * Funções PURAS do diagnóstico das coletas (mig 069). Existem porque, até aqui,
 * uma coleta falhada guardava só o rótulo (`silent_room`, `vexa_failed`) e a
 * causa era indeterminável depois: o worker não registrava o que o Vexa disse.
 */
import type { VexaMeeting } from '../integrations/vexa/client.js';

/** Teto da trilha. Uma coleta normal muda de status ~4 vezes (joining →
 *  awaiting_admission → active → completed); 50 cobre bot que oscila sem deixar
 *  a row crescer sem limite num caso patológico. */
export const STATUS_LOG_CAP = 50;
export const FAILURE_DETAIL_MAX = 500;

export type StatusLogEntry = { at: string; status: string; segments: number };

/** Append com teto: mantém as MAIS RECENTES (a cauda explica a falha). Lixo
 *  vindo do banco (não-array) recomeça a trilha em vez de quebrar o tick. */
export function appendStatusLog(log: unknown, entry: StatusLogEntry, cap = STATUS_LOG_CAP): StatusLogEntry[] {
  const prev = Array.isArray(log) ? (log as StatusLogEntry[]) : [];
  const next = [...prev, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function truncateDetail(s: string, max = FAILURE_DETAIL_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Chaves de motivo que o Vexa grava em `meeting.data` (o sucesso traz
 *  `completion_reason`; a falha, `failure_stage`/`error_details` conforme a
 *  versão). Ordem = ordem de exibição. */
const VEXA_REASON_KEYS = ['completion_reason', 'failure_stage', 'error_details', 'error', 'reason', 'message', 'last_error'];

/**
 * `failure_detail` do vexa_failed: o status + os campos de motivo que existirem
 * em `data` + a última transição (traz `from`, a fase em que o bot morreu). Sem
 * nenhum campo reconhecido, guarda o `data` cru truncado — melhor um JSON feio
 * que nada, porque o formato do Vexa muda entre versões.
 */
export function vexaFailedDetail(meeting: Pick<VexaMeeting, 'status' | 'data'>): string {
  const data = meeting.data && typeof meeting.data === 'object' ? (meeting.data as Record<string, unknown>) : null;
  const parts: string[] = [`status=${meeting.status}`];
  if (data) {
    for (const k of VEXA_REASON_KEYS) {
      const v = data[k];
      if (v == null || v === '') continue;
      parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
    const tr = Array.isArray(data.status_transition) ? data.status_transition : [];
    const last = tr[tr.length - 1] as Record<string, unknown> | undefined;
    if (last && typeof last === 'object') {
      const extra = Object.entries(last)
        .filter(([k]) => !['from', 'to', 'timestamp', 'source'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
      parts.push(`ultima_transicao=${String(last.from ?? '?')}→${String(last.to ?? '?')}${extra.length ? ` (${extra.join(', ')})` : ''}`);
    }
    if (parts.length === 1) parts.push(`data=${JSON.stringify(data)}`);
  }
  return truncateDetail(parts.join('; '));
}

/** `failure_detail` do silent_room: o último status distingue bot preso na sala
 *  de espera (awaiting_admission) de sala ativa e muda (active). */
export function silentRoomDetail(vexaStatus: string | null, waitedMs: number): string {
  return truncateDetail(`ultimo_status_vexa=${vexaStatus ?? 'desconhecido'}; ${Math.round(waitedMs / 1000)}s sem fala`);
}
