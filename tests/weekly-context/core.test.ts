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

test('dueWeekStart: semana corrente de segunda a domingo 19h59', () => {
  assert.equal(dueWeekStart(new Date('2026-11-23T12:00:00-03:00')), '2026-11-23'); // segunda
  assert.equal(dueWeekStart(new Date('2026-11-24T10:00:00-03:00')), '2026-11-23'); // terça
  assert.equal(dueWeekStart(new Date('2026-11-29T19:59:00-03:00')), '2026-11-23'); // domingo 19h59
});

test('dueWeekStart: domingo 20h em diante já é a próxima semana', () => {
  assert.equal(dueWeekStart(new Date('2026-11-29T20:00:00-03:00')), '2026-11-30');
  assert.equal(dueWeekStart(new Date('2026-11-29T23:59:00-03:00')), '2026-11-30');
  // 01:00Z de segunda = domingo 22h SP
  assert.equal(dueWeekStart(new Date('2026-11-30T01:00:00Z')), '2026-11-30');
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
