import { DateTime } from 'luxon';
import type { AgentProjectConfig } from '../db.js';

/**
 * Decide quando o trigger deve disparar, considerando:
 * 1. Debounce/burst smoothing — sempre adiciona `debounceMs` ao "now" base.
 * 2. Quiet hours — se config tem quiet ativo e o horário cai dentro da janela
 *    silenciada, empurra pra próxima ocorrência de `quiet_end` na timezone
 *    configurada.
 *
 * Janelas cruzando meia-noite (start > end, ex: 23:00→07:00) suportadas.
 *
 * Retorna sempre Date em UTC.
 */
export function computeScheduledAt(
  config: AgentProjectConfig | null,
  debounceMs: number,
  now: Date = new Date()
): Date {
  const debounced = new Date(now.getTime() + debounceMs);

  // Sem config ou quiet desligado → só debounce.
  if (!config || !config.quiet_hours_enabled) return debounced;

  const tz = config.quiet_tz;
  const [startH, startM] = parseHHMM(config.quiet_start);
  const [endH, endM] = parseHHMM(config.quiet_end);
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;

  const localDebounced = DateTime.fromJSDate(debounced).setZone(tz);
  if (!localDebounced.isValid) {
    // tz inválida — degrada pra só debounce em vez de quebrar fluxo
    return debounced;
  }
  const localMin = localDebounced.hour * 60 + localDebounced.minute;

  const crossesMidnight = startMin > endMin;
  const inQuiet = crossesMidnight
    ? localMin >= startMin || localMin < endMin
    : localMin >= startMin && localMin < endMin;

  if (!inQuiet) return debounced;

  // Está em quiet — calcula próxima ocorrência de quiet_end na tz.
  // Caso A (mesmo dia, start < end): hoje no endMin (já garantido > localMin).
  // Caso B (cruza meia-noite):
  //   - se localMin >= startMin (lado tarde/noite, antes de meia-noite):
  //     amanhã no endMin.
  //   - se localMin < endMin (madrugada, depois de meia-noite): hoje no endMin.
  let target = localDebounced.set({ hour: endH, minute: endM, second: 0, millisecond: 0 });
  if (crossesMidnight && localMin >= startMin) {
    target = target.plus({ days: 1 });
  }
  return target.toUTC().toJSDate();
}

function parseHHMM(s: string): [number, number] {
  // Aceita 'HH:MM' e 'HH:MM:SS'
  const [h, m] = s.split(':').map(Number);
  return [h ?? 0, m ?? 0];
}
