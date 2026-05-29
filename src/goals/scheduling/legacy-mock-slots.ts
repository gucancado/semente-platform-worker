/**
 * Gerador determinístico legado de slots — preserva comportamento exato do mock
 * antigo em src/sdr/routes.ts. Usado como FALLBACK quando freebusy real falha
 * ou config do projeto não permite (ver service.ts).
 *
 * Regras hardcoded:
 * - Seg-sex, 9-12 e 14-18 fuso BRT (UTC-3).
 * - Antecedência mínima 4h.
 * - Próximos 10 dias úteis.
 * - Espaça 1 slot por dia (quando filtro permissivo).
 * - Pula 9h da segunda e 17h+ da sexta.
 *
 * Quando virar legado total (todo projeto tem OAuth+agenda),
 * este arquivo é deletado.
 */

export type SlotCandidate = {
  iso: string;
  human: string;
  day_label: string;
  hour: number;
  minute: number;
};

export type DayFilter = 'qualquer' | 'seg' | 'ter' | 'qua' | 'qui' | 'sex';
export type PeriodFilter = 'qualquer' | 'manha' | 'tarde';

const WEEKDAY_PT: Record<number, string> = {
  1: 'segunda',
  2: 'terça',
  3: 'quarta',
  4: 'quinta',
  5: 'sexta',
};

const DAY_FILTER_TO_NUM: Record<string, number | null> = {
  qualquer: null,
  seg: 1,
  ter: 2,
  qua: 3,
  qui: 4,
  sex: 5,
};

export function generateLegacyMockSlots(
  dayFilter: DayFilter,
  periodFilter: PeriodFilter,
  now: Date = new Date()
): SlotCandidate[] {
  const dayNum = DAY_FILTER_TO_NUM[dayFilter] ?? null;
  const hours: number[] =
    periodFilter === 'manha' ? [10, 11] :
    periodFilter === 'tarde' ? [14, 15, 16] :
    [10, 11, 14, 15, 16];

  const minStart = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const slots: SlotCandidate[] = [];

  for (let dayOffset = 0; dayOffset < 14 && slots.length < 3; dayOffset++) {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    const wd = d.getDay();
    if (wd < 1 || wd > 5) continue;
    if (dayNum !== null && wd !== dayNum) continue;

    for (const hour of hours) {
      if (slots.length >= 3) break;
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(hour).padStart(2, '0');
      const iso = `${yyyy}-${mm}-${dd}T${hh}:00:00-03:00`;
      const slotDate = new Date(iso);
      if (slotDate < minStart) continue;
      if (wd === 1 && hour < 10) continue;
      if (wd === 5 && hour >= 17) continue;

      const dayLabel = `${WEEKDAY_PT[wd]} (${dd}/${mm})`;
      slots.push({ iso, human: `${dayLabel} às ${hh}h`, day_label: dayLabel, hour, minute: 0 });

      if (dayFilter === 'qualquer') break;
    }
  }

  return slots;
}
