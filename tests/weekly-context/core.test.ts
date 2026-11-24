/** tests/weekly-context/core.test.ts — partes puras do resumo semanal. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, buildWeeklyContextPrompt, cleanSummary, clientNameFromGroup, dueWeekStart, saoPauloParts,
} from '../../src/weekly-context/core.js';

test('saoPauloParts: 01:30Z de terça é segunda 22h em SP', () => {
  const p = saoPauloParts(new Date('2026-11-24T01:30:00Z'));
  assert.deepEqual(p, { day: '2026-11-23', dow: 1, hour: 22 });
});

test('addDays atravessa mês', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-12-01', -1), '2026-11-30');
});

test('dueWeekStart: semana corrente a partir de segunda 6h', () => {
  assert.equal(dueWeekStart(new Date('2026-11-23T06:00:00-03:00')), '2026-11-23'); // segunda 6h
  assert.equal(dueWeekStart(new Date('2026-11-24T10:00:00-03:00')), '2026-11-23'); // terça
  assert.equal(dueWeekStart(new Date('2026-11-29T23:59:00-03:00')), '2026-11-23'); // domingo
});

test('dueWeekStart: antes de segunda 6h ainda é a semana anterior', () => {
  assert.equal(dueWeekStart(new Date('2026-11-30T05:59:00-03:00')), '2026-11-23');
  // 02:00Z de segunda = domingo 23h SP
  assert.equal(dueWeekStart(new Date('2026-11-30T02:00:00Z')), '2026-11-23');
  assert.equal(dueWeekStart(new Date('2026-11-30T06:00:00-03:00')), '2026-11-30');
});

test('prompt: marca autoria e avisa ausência de material', () => {
  const { system, user } = buildWeeklyContextPrompt({
    clientName: 'Hoenka', today: '24/11/2026',
    messages: [{ at: '23/11 10:34', role: 'cliente', text: 'beleza' }], meetings: [],
  });
  assert.match(system, /NO MÁXIMO 60 palavras/);
  assert.match(system, /Proibido citar/);
  assert.match(user, /Cliente: Hoenka/);
  assert.match(user, /\[23\/11 10:34\] cliente: beleza/);
  assert.match(user, /nenhuma reunião transcrita/);
});

test('cleanSummary: uma linha, sem markdown nem aspas externas', () => {
  assert.equal(cleanSummary('"**Leads** ruins.\n\nCliente   insatisfeito."'), 'Leads ruins. Cliente insatisfeito.');
});

test('clientNameFromGroup', () => {
  assert.equal(clientNameFromGroup('Hoenka + BeeAds'), 'Hoenka');
  assert.equal(clientNameFromGroup('Dra Karine França +BeeAds'), 'Dra Karine França');
  assert.equal(clientNameFromGroup(null), 'cliente');
});
