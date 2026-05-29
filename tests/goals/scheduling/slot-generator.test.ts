import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSlotsFromWorkingHours } from '../../../src/goals/scheduling/slot-generator.js';
import type { WorkingHours } from '../../../src/admin/db.js';

const TYPICAL_WH: WorkingHours = {
  mon: ['09:00-12:00', '14:00-18:00'],
  tue: ['09:00-12:00', '14:00-18:00'],
  wed: ['09:00-12:00', '14:00-18:00'],
  thu: ['09:00-12:00', '14:00-18:00'],
  fri: ['09:00-12:00', '14:00-17:00'],
  timezone: 'America/Sao_Paulo',
};

// Segunda-feira 09:00 BRT = 2026-06-01T12:00:00Z
const MONDAY_NOW = new Date('2026-06-01T12:00:00Z');

test('working hours simples, sem busy, dayFilter=qualquer → gera 3 slots em 3 dias', () => {
  const slots = generateSlotsFromWorkingHours({
    workingHours: TYPICAL_WH,
    busyRanges: [],
    meetingDurationMin: 30,
    minAdvanceHours: 0,
    maxAdvanceBusinessDays: 5,
    dayFilter: 'qualquer',
    periodFilter: 'qualquer',
    now: MONDAY_NOW,
  });
  assert.equal(slots.length, 3);
  const labels = slots.map((s) => s.day_label);
  assert.equal(new Set(labels).size, 3);
});

test('dayFilter=qui → só quintas', () => {
  const slots = generateSlotsFromWorkingHours({
    workingHours: TYPICAL_WH,
    busyRanges: [],
    meetingDurationMin: 30,
    minAdvanceHours: 0,
    maxAdvanceBusinessDays: 10,
    dayFilter: 'qui',
    periodFilter: 'qualquer',
    now: MONDAY_NOW,
  });
  assert.equal(slots.length, 3);
  for (const s of slots) {
    assert.match(s.day_label, /quinta/);
  }
});

test('periodFilter=tarde ignora janelas que começam antes de 12h', () => {
  const slots = generateSlotsFromWorkingHours({
    workingHours: TYPICAL_WH,
    busyRanges: [],
    meetingDurationMin: 30,
    minAdvanceHours: 0,
    maxAdvanceBusinessDays: 3,
    dayFilter: 'qualquer',
    periodFilter: 'tarde',
    now: MONDAY_NOW,
  });
  assert.equal(slots.length, 3);
  for (const s of slots) {
    assert.ok(s.hour >= 14, `slot ${s.iso} deveria ser tarde`);
  }
});

test('periodFilter=manha ignora janelas que começam em 12h+', () => {
  const slots = generateSlotsFromWorkingHours({
    workingHours: TYPICAL_WH,
    busyRanges: [],
    meetingDurationMin: 30,
    minAdvanceHours: 0,
    maxAdvanceBusinessDays: 3,
    dayFilter: 'qualquer',
    periodFilter: 'manha',
    now: MONDAY_NOW,
  });
  assert.equal(slots.length, 3);
  for (const s of slots) {
    assert.ok(s.hour < 12, `slot ${s.iso} deveria ser manhã`);
  }
});

test('busy range bloqueia primeiro slot do dia', () => {
  const busy = [{
    start: '2026-06-01T12:00:00-00:00',
    end: '2026-06-01T15:00:00-00:00',
  }];
  const slots = generateSlotsFromWorkingHours({
    workingHours: TYPICAL_WH,
    busyRanges: busy,
    meetingDurationMin: 30,
    minAdvanceHours: 0,
    maxAdvanceBusinessDays: 5,
    dayFilter: 'qualquer',
    periodFilter: 'qualquer',
    now: MONDAY_NOW,
  });
  assert.equal(slots.length, 3);
  const segSlot = slots.find((s) => s.day_label.startsWith('segunda'));
  assert.ok(segSlot, 'deve ter slot de segunda');
  assert.ok(segSlot!.hour >= 14, `segunda deveria começar em 14h+, recebi ${segSlot!.hour}`);
});

test('duração 60min em janela 9-10:30 → 1 slot só (9:00)', () => {
  const wh: WorkingHours = {
    mon: ['09:00-10:30'],
    tue: ['09:00-10:30'],
    timezone: 'America/Sao_Paulo',
  };
  const slots = generateSlotsFromWorkingHours({
    workingHours: wh,
    busyRanges: [],
    meetingDurationMin: 60,
    minAdvanceHours: 0,
    maxAdvanceBusinessDays: 2,
    dayFilter: 'qualquer',
    periodFilter: 'qualquer',
    now: MONDAY_NOW,
  });
  for (const s of slots) {
    assert.equal(s.hour, 9);
    assert.equal(s.minute, 0);
  }
});

test('antecedência mínima 24h: now segunda 12h UTC → segunda toda é pulada', () => {
  const slots = generateSlotsFromWorkingHours({
    workingHours: TYPICAL_WH,
    busyRanges: [],
    meetingDurationMin: 30,
    minAdvanceHours: 24,
    maxAdvanceBusinessDays: 5,
    dayFilter: 'qualquer',
    periodFilter: 'qualquer',
    now: MONDAY_NOW,
  });
  assert.ok(slots.length > 0);
  for (const s of slots) {
    assert.ok(!s.day_label.startsWith('segunda'), `${s.iso} segunda foi incluída`);
  }
});

test('antecedência máxima 2 dias úteis: não inclui slot além de now+4 dias corridos', () => {
  const slots = generateSlotsFromWorkingHours({
    workingHours: TYPICAL_WH,
    busyRanges: [],
    meetingDurationMin: 30,
    minAdvanceHours: 0,
    maxAdvanceBusinessDays: 2,
    dayFilter: 'qualquer',
    periodFilter: 'qualquer',
    now: MONDAY_NOW,
  });
  for (const s of slots) {
    const diff = new Date(s.iso).getTime() - MONDAY_NOW.getTime();
    assert.ok(diff < 5 * 24 * 60 * 60 * 1000, `${s.iso} fora do range`);
  }
});

test('working hours só sat/sun: seg-sex são pulados', () => {
  const wh: WorkingHours = {
    sat: ['10:00-14:00'],
    sun: ['10:00-12:00'],
    timezone: 'America/Sao_Paulo',
  };
  const slots = generateSlotsFromWorkingHours({
    workingHours: wh,
    busyRanges: [],
    meetingDurationMin: 30,
    minAdvanceHours: 0,
    maxAdvanceBusinessDays: 5,
    dayFilter: 'qualquer',
    periodFilter: 'qualquer',
    now: MONDAY_NOW,
  });
  for (const s of slots) {
    assert.ok(
      s.day_label.startsWith('sábado') || s.day_label.startsWith('domingo'),
      `${s.iso} esperava sat/sun`
    );
  }
});

test('UTC timezone: ISO output usa offset -00:00 ou +00:00', () => {
  const wh: WorkingHours = {
    mon: ['09:00-12:00'],
    timezone: 'UTC',
  };
  // maxAdvanceBusinessDays=5 → 10 dias corridos, cobre a próxima segunda (2026-06-08)
  // pois MONDAY_NOW=12:00 UTC e a janela 09:00-12:00 UTC já passou neste dia
  const slots = generateSlotsFromWorkingHours({
    workingHours: wh,
    busyRanges: [],
    meetingDurationMin: 30,
    minAdvanceHours: 0,
    maxAdvanceBusinessDays: 5,
    dayFilter: 'seg',
    periodFilter: 'qualquer',
    now: MONDAY_NOW,
  });
  assert.ok(slots.length > 0);
  for (const s of slots) {
    assert.match(s.iso, /\+00:00|Z$/);
  }
});

test('slot exato no fim de busy: end (busy)=11:00, candidate (start)=11:00 → não pula', () => {
  const wh: WorkingHours = {
    tue: ['09:00-12:00'],
    timezone: 'America/Sao_Paulo',
  };
  const busy = [{
    start: '2026-06-02T12:00:00-00:00',
    end: '2026-06-02T14:00:00-00:00',
  }];
  const slots = generateSlotsFromWorkingHours({
    workingHours: wh,
    busyRanges: busy,
    meetingDurationMin: 30,
    minAdvanceHours: 0,
    maxAdvanceBusinessDays: 5,
    dayFilter: 'ter',
    periodFilter: 'qualquer',
    now: MONDAY_NOW,
  });
  assert.ok(slots.length > 0);
  assert.equal(slots[0]!.hour, 11);
  assert.equal(slots[0]!.minute, 0);
});

test('working hours vazio: retorna []', () => {
  const wh: WorkingHours = { timezone: 'America/Sao_Paulo' };
  const slots = generateSlotsFromWorkingHours({
    workingHours: wh,
    busyRanges: [],
    meetingDurationMin: 30,
    minAdvanceHours: 0,
    maxAdvanceBusinessDays: 5,
    dayFilter: 'qualquer',
    periodFilter: 'qualquer',
    now: MONDAY_NOW,
  });
  assert.deepEqual(slots, []);
});

test('duração 30min em janela 9-12 + 14-18 com dayFilter restritivo: múltiplos slots por dia', () => {
  const wh: WorkingHours = {
    mon: ['09:00-12:00', '14:00-18:00'],
    timezone: 'America/Sao_Paulo',
  };
  const slots = generateSlotsFromWorkingHours({
    workingHours: wh,
    busyRanges: [],
    meetingDurationMin: 30,
    minAdvanceHours: 0,
    maxAdvanceBusinessDays: 5,
    dayFilter: 'seg',
    periodFilter: 'qualquer',
    now: MONDAY_NOW,
    maxResults: 3,
  });
  assert.equal(slots.length, 3);
  assert.ok(slots.every((s) => s.day_label.startsWith('segunda')));
});

test('maxResults respeitado', () => {
  const slots = generateSlotsFromWorkingHours({
    workingHours: TYPICAL_WH,
    busyRanges: [],
    meetingDurationMin: 30,
    minAdvanceHours: 0,
    maxAdvanceBusinessDays: 10,
    dayFilter: 'qualquer',
    periodFilter: 'qualquer',
    now: MONDAY_NOW,
    maxResults: 5,
  });
  assert.equal(slots.length, 5);
});

test('formato human: HH:MM quando minute != 0; HHh quando minute == 0', () => {
  const wh: WorkingHours = {
    mon: ['09:30-12:00'],
    timezone: 'America/Sao_Paulo',
  };
  const slots = generateSlotsFromWorkingHours({
    workingHours: wh,
    busyRanges: [],
    meetingDurationMin: 30,
    minAdvanceHours: 0,
    maxAdvanceBusinessDays: 5,
    dayFilter: 'seg',
    periodFilter: 'qualquer',
    now: MONDAY_NOW,
    maxResults: 1,
  });
  assert.equal(slots.length, 1);
  assert.match(slots[0]!.human, /09h30/);
});
