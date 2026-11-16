/**
 * tests/whatsapp/response-time.test.ts — agregação PURA (sem banco).
 * Horário comercial = seg–sex 09h–18h de São Paulo (UTC-3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateResponseTurns, percentile, type ResponseTurn } from '../../src/whatsapp/response-time.js';
import { isWithinBusinessHours } from '../../src/whatsapp/business-hours.js';

// 2026-11-17 é terça. 10:00 BRT = 13:00Z.
const t = (iso: string) => new Date(iso);

test('vez respondida em 10 min de expediente entra na meta de 15', () => {
  const turns: ResponseTurn[] = [
    { startAt: t('2026-11-17T13:00:00Z'), respondedAt: t('2026-11-17T13:10:00Z'), isFirstContact: true },
  ];
  const s = aggregateResponseTurns(turns);
  assert.equal(s.turns, 1);
  assert.equal(s.answered, 1);
  assert.equal(s.timed, 1);
  assert.equal(s.withinSla, 1);
  assert.equal(s.withinSlaPct, 100);
  assert.equal(s.medianMinutes, 10);
  assert.equal(s.firstResponseMedianMinutes, 10);
  assert.deepEqual(s.series, [{ date: '2026-11-17', turns: 1, unanswered: 0, timed: 1, withinSla: 1, sumMinutes: 10 }]);
});

test('vez que começa fora do expediente conta como vez, mas fica fora do tempo', () => {
  // 23:00 BRT de terça = 02:00Z de quarta, respondida às 09:05 BRT de quarta
  const s = aggregateResponseTurns([
    { startAt: t('2026-11-18T02:00:00Z'), respondedAt: t('2026-11-18T12:05:00Z'), isFirstContact: false },
  ]);
  assert.equal(s.turns, 1);
  assert.equal(s.answered, 1);
  assert.equal(s.offHours, 1);
  assert.equal(s.timed, 0);
  assert.equal(s.medianMinutes, null);
  // o dia da vez é o de São Paulo (terça), não o UTC
  assert.equal(s.series[0]!.date, '2026-11-17');
});

test('vez que começa às 17:50 e é respondida às 09:10 do dia seguinte vale 20 min', () => {
  const s = aggregateResponseTurns([
    { startAt: t('2026-11-17T20:50:00Z'), respondedAt: t('2026-11-18T12:10:00Z'), isFirstContact: false },
  ]);
  assert.equal(s.medianMinutes, 20);
});

test('sem resposta conta como unanswered e fica fora da mediana', () => {
  const s = aggregateResponseTurns([
    { startAt: t('2026-11-17T13:00:00Z'), respondedAt: t('2026-11-17T14:00:00Z'), isFirstContact: false },
    { startAt: t('2026-11-17T15:00:00Z'), respondedAt: null, isFirstContact: true },
  ]);
  assert.equal(s.answered, 1);
  assert.equal(s.unanswered, 1);
  assert.equal(s.withinSla, 0);
  assert.equal(s.withinSlaPct, 0);
  assert.equal(s.medianMinutes, 60);
  assert.equal(s.firstContacts, 1);
  assert.equal(s.firstResponseMedianMinutes, null);
});

test('média, mediana e p90', () => {
  const mins = [1, 2, 3, 4, 100];
  const turns = mins.map((m) => ({
    startAt: t('2026-11-17T13:00:00Z'),
    respondedAt: new Date(t('2026-11-17T13:00:00Z').getTime() + m * 60_000),
    isFirstContact: false,
  }));
  const s = aggregateResponseTurns(turns);
  assert.equal(s.medianMinutes, 3);
  assert.equal(s.avgMinutes, 22);
  assert.equal(s.p90Minutes, 61.6);
  assert.equal(s.withinSlaPct, 80);
});

test('vazio → nulls', () => {
  const s = aggregateResponseTurns([]);
  assert.equal(s.turns, 0);
  assert.equal(s.medianMinutes, null);
  assert.equal(s.withinSlaPct, null);
  assert.equal(s.avgMinutes, null);
  assert.deepEqual(s.series, []);
  assert.equal(percentile([], 0.5), null);
});

test('isWithinBusinessHours: 09:00 entra, 18:00 sai, sábado e feriado saem', () => {
  assert.equal(isWithinBusinessHours(t('2026-11-17T12:00:00Z')), true); // ter 09:00
  assert.equal(isWithinBusinessHours(t('2026-11-17T11:59:00Z')), false); // ter 08:59
  assert.equal(isWithinBusinessHours(t('2026-11-17T21:00:00Z')), false); // ter 18:00
  assert.equal(isWithinBusinessHours(t('2026-11-21T15:00:00Z')), false); // sáb
  assert.equal(isWithinBusinessHours(t('2026-11-20T15:00:00Z')), false); // feriado 20/11
});
