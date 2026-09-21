import { DateTime } from 'luxon';

/**
 * Relógio de EXPEDIENTE — quanto tempo útil cabe entre dois instantes.
 *
 * Existe por causa do vigia de instância de sistema. O `saturno` só participa de
 * grupos de equipe, que ficam mudos à noite e no fim de semana (medido em
 * 2026-09: 100–136 msgs em dia útil, 0–2 no fim de semana); os pares com que ele
 * era comparado são números de ATENDIMENTO, que recebem lead de madrugada e no
 * domingo. Medir o atraso do store pelo relógio de parede denunciava o saturno
 * toda vez que um lead escrevia fora de hora: 11 avisos falsos em uma semana.
 * Medido em expediente, o silêncio de quem só fala em horário comercial vale zero
 * fora dele — e a sessão zumbi de um dia útil continua sendo pega no mesmo prazo.
 *
 * Sempre em São Paulo, explícito: o container roda em UTC.
 */

const ZONE = 'America/Sao_Paulo';
const OPEN_HOUR = 9;
const CLOSE_HOUR = 18;
/** Teto de dias varridos. Acima disso o total já estourou qualquer limite útil. */
const MAX_DAYS = 370;

/** Feriados nacionais de data fixa (MM-dd). */
const FIXED_HOLIDAYS = new Set(['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25']);
/** Dias em relação ao domingo de Páscoa: Carnaval (seg e ter), Sexta-feira Santa, Corpus Christi. */
const EASTER_OFFSETS = new Set([-48, -47, -2, 60]);

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher, calendário gregoriano). */
function easterSunday(year: number): DateTime {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return DateTime.fromObject({ year, month, day }, { zone: ZONE });
}

function isHoliday(day: DateTime): boolean {
  if (FIXED_HOLIDAYS.has(day.toFormat('MM-dd'))) return true;
  // Todos os móveis caem no mesmo ano civil da Páscoa, então o ordinal basta.
  return EASTER_OFFSETS.has(day.ordinal - easterSunday(day.year).ordinal);
}

function isBusinessLocalDay(day: DateTime): boolean {
  // luxon: 1 = segunda … 7 = domingo
  return day.weekday <= 5 && !isHoliday(day);
}

/** O dia (de São Paulo) em que `d` cai é dia útil? Só feriado NACIONAL entra na conta. */
export function isBusinessDay(d: Date): boolean {
  return isBusinessLocalDay(DateTime.fromJSDate(d, { zone: ZONE }));
}

/** Milissegundos de expediente (seg–sex, 09h–18h de São Paulo, fora feriado nacional) entre dois instantes. */
export function businessMsBetween(from: Date, to: Date): number {
  const start = from.getTime();
  const end = to.getTime();
  if (!(end > start)) return 0;

  let total = 0;
  let day = DateTime.fromJSDate(from, { zone: ZONE }).startOf('day');
  for (let n = 0; n < MAX_DAYS && day.toMillis() <= end; n++, day = day.plus({ days: 1 })) {
    if (!isBusinessLocalDay(day)) continue;
    const open = Math.max(day.set({ hour: OPEN_HOUR }).toMillis(), start);
    const close = Math.min(day.set({ hour: CLOSE_HOUR }).toMillis(), end);
    if (close > open) total += close - open;
  }
  return total;
}
