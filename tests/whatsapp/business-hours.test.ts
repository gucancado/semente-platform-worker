import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessMsBetween, isBusinessDay } from '../../src/whatsapp/business-hours.js';

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
