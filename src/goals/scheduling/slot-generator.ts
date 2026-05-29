/**
 * Pure function: dado working_hours + busy ranges, gera N slot candidatos.
 * Sem dependência de DB, sem dependência de Google.
 * Usado pelo service.ts quando freebusy real está disponível.
 */

import { DateTime } from 'luxon';
import type { WorkingHours } from '../../admin/db.js';
import type { SlotCandidate, DayFilter, PeriodFilter } from './legacy-mock-slots.js';

export type { SlotCandidate, DayFilter, PeriodFilter };

export type BusyRange = { start: string; end: string }; // ISO 8601 com offset

export type GenerateInput = {
  workingHours: WorkingHours;
  busyRanges: BusyRange[];
  meetingDurationMin: number;
  minAdvanceHours: number;
  maxAdvanceBusinessDays: number;
  dayFilter: DayFilter;
  periodFilter: PeriodFilter;
  now: Date;
  maxResults?: number;
};

const DAYS_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DAY_PT: Record<number, string> = {
  0: 'domingo',
  1: 'segunda',
  2: 'terça',
  3: 'quarta',
  4: 'quinta',
  5: 'sexta',
  6: 'sábado',
};
const DAY_FILTER_TO_NUM: Record<DayFilter, number | null> = {
  qualquer: null,
  seg: 1,
  ter: 2,
  qua: 3,
  qui: 4,
  sex: 5,
};

function parseHHMM(s: string): { hour: number; minute: number } {
  const [h, m] = s.split(':');
  return { hour: Number(h), minute: Number(m) };
}

function overlapsBusy(start: DateTime, end: DateTime, busyRanges: BusyRange[]): boolean {
  for (const b of busyRanges) {
    const bStart = DateTime.fromISO(b.start);
    const bEnd = DateTime.fromISO(b.end);
    // Overlap se [start, end) intersecta [bStart, bEnd).
    if (start < bEnd && end > bStart) return true;
  }
  return false;
}

export function generateSlotsFromWorkingHours(input: GenerateInput): SlotCandidate[] {
  const maxResults = input.maxResults ?? 3;
  const slots: SlotCandidate[] = [];
  const tz = input.workingHours.timezone;
  const dayNum = DAY_FILTER_TO_NUM[input.dayFilter];

  // minStart = now + minAdvanceHours
  const minStart = DateTime.fromJSDate(input.now).setZone(tz).plus({ hours: input.minAdvanceHours });
  // maxEnd = now + maxAdvanceBusinessDays * 2 dias corridos (aproximação que cobre fim de semana)
  const maxEnd = DateTime.fromJSDate(input.now).setZone(tz).plus({ days: input.maxAdvanceBusinessDays * 2 });

  // Itera dias do calendário
  for (
    let cursor = DateTime.fromJSDate(input.now).setZone(tz).startOf('day');
    cursor <= maxEnd && slots.length < maxResults;
    cursor = cursor.plus({ days: 1 })
  ) {
    const wd = cursor.weekday % 7; // luxon: 1=monday..7=sunday → 0=sunday..6=saturday for our DAYS_KEYS
    const dayKey = DAYS_KEYS[wd]!;
    const windows = input.workingHours[dayKey];
    if (!windows || windows.length === 0) continue;

    // Aplicar dayFilter (somente mapeia seg-sex; se filter=qualquer, todos passam)
    if (dayNum !== null && cursor.weekday !== dayNum) continue;

    let dayHadSlot = false;

    for (const range of windows) {
      // Cada range é "HH:MM-HH:MM"
      const [startStr, endStr] = range.split('-');
      if (!startStr || !endStr) continue;
      const { hour: sH, minute: sM } = parseHHMM(startStr);
      const { hour: eH, minute: eM } = parseHHMM(endStr);

      // Aplicar periodFilter
      if (input.periodFilter === 'manha' && sH >= 12) continue;
      if (input.periodFilter === 'tarde' && sH < 12) continue;

      // Step pela duração da reunião
      let candidateStart = cursor.set({ hour: sH, minute: sM, second: 0, millisecond: 0 });
      const windowEnd = cursor.set({ hour: eH, minute: eM, second: 0, millisecond: 0 });

      while (
        candidateStart.plus({ minutes: input.meetingDurationMin }) <= windowEnd &&
        slots.length < maxResults
      ) {
        const candidateEnd = candidateStart.plus({ minutes: input.meetingDurationMin });

        if (candidateStart < minStart) {
          candidateStart = candidateStart.plus({ minutes: input.meetingDurationMin });
          continue;
        }

        if (overlapsBusy(candidateStart, candidateEnd, input.busyRanges)) {
          candidateStart = candidateStart.plus({ minutes: input.meetingDurationMin });
          continue;
        }

        const iso = candidateStart.toISO({ suppressMilliseconds: true })!;
        const dd = String(candidateStart.day).padStart(2, '0');
        const mm = String(candidateStart.month).padStart(2, '0');
        const dayLabel = `${DAY_PT[cursor.weekday % 7]} (${dd}/${mm})`;
        const hh = String(candidateStart.hour).padStart(2, '0');
        const mmm = String(candidateStart.minute).padStart(2, '0');
        const humanTime = candidateStart.minute === 0 ? `${hh}h` : `${hh}h${mmm}`;
        slots.push({
          iso,
          human: `${dayLabel} às ${humanTime}`,
          day_label: dayLabel,
          hour: candidateStart.hour,
          minute: candidateStart.minute,
        });

        dayHadSlot = true;

        // Espaçamento: 1 slot por dia quando dayFilter=qualquer (igual mock)
        if (input.dayFilter === 'qualquer') break;

        candidateStart = candidateStart.plus({ minutes: input.meetingDurationMin });
      }

      if (dayHadSlot && input.dayFilter === 'qualquer') break;
    }
  }

  return slots;
}
