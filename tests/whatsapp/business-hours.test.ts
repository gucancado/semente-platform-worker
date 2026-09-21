import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessMsBetween, isBusinessDay, parseOffDates } from '../../src/whatsapp/business-hours.js';

const H = 3_600_000;
const MIN = 60_000;
/** Instante a partir de hora de SÃO PAULO (UTC-3, sem horário de verão desde 2019). */
const brt = (s: string) => new Date(`${s}:00-03:00`);

test('dentro do mesmo dia útil conta o intervalo inteiro', () => {
  // terça 22/09/2026
  assert.equal(businessMsBetween(brt('2026-09-22T10:00'), brt('2026-09-22T16:05')), 6 * H + 5 * MIN);
});

test('recorta no expediente: antes das 9h e depois das 18h não contam', () => {
  assert.equal(businessMsBetween(brt('2026-09-22T06:00'), brt('2026-09-22T23:00')), 9 * H);
});

test('noite e fim de semana valem zero (o aviso falso de 21/09 06:24)', () => {
  // domingo 20/09 20:06 → segunda 21/09 06:20
  assert.equal(businessMsBetween(brt('2026-09-20T20:06'), brt('2026-09-21T06:20')), 0);
});

test('atravessa o fim de semana somando só sexta e segunda', () => {
  // sexta 25/09 17:00 → segunda 28/09 14:00 = 1h + 5h
  assert.equal(businessMsBetween(brt('2026-09-25T17:00'), brt('2026-09-28T14:00')), 6 * H);
});

test('o dia é o de São Paulo, não o UTC do container', () => {
  // sexta 25/09 21:30 BRT já é sábado 00:30 em UTC — e continua sendo fora do expediente de sexta
  assert.equal(businessMsBetween(brt('2026-09-25T17:30'), brt('2026-09-25T21:30')), 30 * MIN);
  // segunda 28/09 09:00 BRT = 12:00Z
  assert.equal(businessMsBetween(new Date('2026-09-28T11:00:00Z'), new Date('2026-09-28T13:00:00Z')), 1 * H);
});

test('intervalo invertido ou vazio vale zero', () => {
  assert.equal(businessMsBetween(brt('2026-09-22T12:00'), brt('2026-09-22T12:00')), 0);
  assert.equal(businessMsBetween(brt('2026-09-22T16:00'), brt('2026-09-22T10:00')), 0);
});

test('feriado nacional fixo em dia útil não conta (12/10/2026, segunda)', () => {
  // sexta 09/10 17:30 → segunda 12/10 17:00: só os 30min da sexta
  assert.equal(businessMsBetween(brt('2026-10-09T17:30'), brt('2026-10-12T17:00')), 30 * MIN);
  // …e o relógio volta a andar na terça
  assert.equal(businessMsBetween(brt('2026-10-09T17:30'), brt('2026-10-13T14:30')), 6 * H);
});

test('feriados móveis saem da Páscoa: Carnaval, Sexta-feira Santa e Corpus Christi', () => {
  const day = (s: string) => isBusinessDay(brt(`${s}T12:00`));
  // Páscoa 2026 = 05/04
  assert.equal(day('2026-02-16'), false); // segunda de Carnaval
  assert.equal(day('2026-02-17'), false); // terça de Carnaval
  assert.equal(day('2026-02-18'), true); //  quarta de cinzas conta
  assert.equal(day('2026-04-03'), false); // Sexta-feira Santa
  assert.equal(day('2026-06-04'), false); // Corpus Christi
  // Páscoa 2027 = 28/03
  assert.equal(day('2027-02-08'), false);
  assert.equal(day('2027-03-26'), false);
  assert.equal(day('2027-05-27'), false);
});

test('dia útil comum, sábado, domingo e feriados fixos', () => {
  const day = (s: string) => isBusinessDay(brt(`${s}T12:00`));
  assert.equal(day('2026-09-21'), true); //  segunda
  assert.equal(day('2026-09-19'), false); // sábado
  assert.equal(day('2026-09-20'), false); // domingo
  assert.equal(day('2026-11-02'), false); // Finados (segunda)
  assert.equal(day('2026-11-20'), false); // Consciência Negra (sexta)
  assert.equal(day('2026-12-25'), false); // Natal (sexta)
  assert.equal(day('2027-01-01'), false); // Confraternização (sexta)
  assert.equal(day('2027-04-21'), false); // Tiradentes (quarta)
});

test('intervalo absurdo de longo termina (teto de iteração) e segue acima de qualquer limite', () => {
  const ms = businessMsBetween(brt('2015-01-01T00:00'), brt('2026-09-21T12:00'));
  assert.ok(ms > 1000 * H);
});

// ── Datas extras sem expediente (BUSINESS_HOURS_EXTRA_OFF_DATES) ────────────────
// Dias úteis de calendário em que os grupos de equipe ficam mudos: feriado de BH
// (08/12, 15/08), véspera (24/12, 31/12), Quarta de Cinzas, recesso.

test('sem datas extras, 08/12 (feriado de BH), 24/12 e a Quarta de Cinzas contam como dia útil', () => {
  const day = (s: string) => isBusinessDay(brt(`${s}T12:00`));
  assert.equal(day('2026-12-08'), true); // terça
  assert.equal(day('2026-12-24'), true); // quinta
  assert.equal(day('2026-02-18'), true); // Quarta de Cinzas
});

test('data extra tira o dia do expediente — no dia CIVIL de São Paulo', () => {
  const off = parseOffDates('2026-12-08,2026-12-24').dates;
  assert.equal(isBusinessDay(brt('2026-12-08T12:00'), off), false);
  assert.equal(isBusinessDay(brt('2026-12-24T09:00'), off), false);
  assert.equal(isBusinessDay(brt('2026-12-09T12:00'), off), true);
  // 08/12 23:30 BRT já é 09/12 em UTC — e continua sendo o dia 08 de São Paulo
  assert.equal(isBusinessDay(new Date('2026-12-09T02:30:00Z'), off), false);
  // 09/12 00:30 BRT ainda é 09/12 03:30Z: dia útil
  assert.equal(isBusinessDay(new Date('2026-12-09T03:30:00Z'), off), true);
});

test('o store_stale falso das ~15h de um feriado local desaparece com a data extra', () => {
  // segunda 07/12 17:30 → terça 08/12 (feriado de BH) 17:00
  const from = brt('2026-12-07T17:30');
  const to = brt('2026-12-08T17:00');
  assert.equal(businessMsBetween(from, to), 30 * MIN + 8 * H); //         sem a data: 8h30 ≥ 6h → falso positivo
  assert.equal(businessMsBetween(from, to, parseOffDates('2026-12-08').dates), 30 * MIN); // com a data: 30min
});

test('recesso inteiro: o relógio só volta a andar no primeiro dia de expediente', () => {
  const off = parseOffDates('2026-12-24,2026-12-28,2026-12-29,2026-12-30,2026-12-31').dates;
  // quarta 23/12 17:00 → segunda 04/01/2027 10:00 = 1h (23/12) + 1h (04/01); 25/12 e 01/01 já são nacionais
  assert.equal(businessMsBetween(brt('2026-12-23T17:00'), brt('2027-01-04T10:00'), off), 2 * H);
});

test('parseOffDates é TOLERANTE: fica com o que é válido e devolve o resto para o warn', () => {
  const r = parseOffDates(' 2026-12-08 , lixo,2026-02-30,2026-13-01, 2026-12-24,,08/12/2026,2026-12-8 ');
  assert.deepEqual([...r.dates].sort(), ['2026-12-08', '2026-12-24']);
  assert.deepEqual(r.invalid, ['lixo', '2026-02-30', '2026-13-01', '08/12/2026', '2026-12-8']);
});

test('parseOffDates com env ausente, vazia ou só de vírgulas não inventa nada e não lança', () => {
  for (const raw of [undefined, null, '', ' ', ',,,']) {
    const r = parseOffDates(raw as any);
    assert.equal(r.dates.size, 0);
    assert.deepEqual(r.invalid, []);
  }
});
