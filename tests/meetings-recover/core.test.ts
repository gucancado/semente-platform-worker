import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  speechSecondsFromSilencedetect, chunkStarts, pickReferenceClips, nameLabels, toRelativeActivity, UNKNOWN_SPEAKER,
} from '../../src/meetings-recover/core.js';
import { parseSpeakerActivityBody, MAX_EVENTS } from '../../src/meetings-recover/speaker-activity.js';
import { nextJobOutcome } from '../../src/meetings-summary/retry-policy.js';

test('fala = duração − silêncios; silêncio aberto vai até o fim', () => {
  const err = [
    '[silencedetect @ 0x1] silence_start: 0',
    '[silencedetect @ 0x1] silence_end: 10 | silence_duration: 10',
    '[silencedetect @ 0x1] silence_start: 100',
  ].join('\n');
  assert.equal(speechSecondsFromSilencedetect(err, 120), 90);
});

test('sala muda: arquivo todo silêncio → 0', () => {
  assert.equal(speechSecondsFromSilencedetect('silence_start: 0\n', 1200), 0);
});

test('chunkStarts cobre a gravação em pedaços de 240 s', () => {
  assert.deepEqual(chunkStarts(1227), [0, 240, 480, 720, 960, 1200]);
});

test('toRelativeActivity descarta o nome genérico "Speaker"', () => {
  const t0 = new Date('2026-10-01T18:30:00Z');
  const a = toRelativeActivity([
    { speaker: 'Speaker', started_at: new Date(t0.getTime() + 1000), ended_at: new Date(t0.getTime() + 5000) },
    { speaker: 'Lucas Marques', started_at: new Date(t0.getTime() + 10_000), ended_at: new Date(t0.getTime() + 20_000) },
  ], t0);
  assert.deepEqual(a, [{ speaker: 'Lucas Marques', startS: 10, endS: 20 }]);
});

test('pickReferenceClips: top falantes, trecho 3–8 s do intervalo mais longo', () => {
  const act = [
    { speaker: 'Leo', startS: 100, endS: 130 },
    { speaker: 'Lucas', startS: 10, endS: 14 },
    { speaker: 'Lucas', startS: 50, endS: 52 },
    { speaker: 'Gu', startS: 200, endS: 201 }, // curto demais
  ];
  assert.deepEqual(pickReferenceClips(act, 1200), [
    { name: 'Leo', startS: 100.5, lenS: 8 },
    { name: 'Lucas', startS: 10.5, lenS: 3.5 },
  ]);
});

test('pickReferenceClips: máximo 4', () => {
  const act = ['a', 'b', 'c', 'd', 'e'].map((n, i) => ({ speaker: n, startS: i * 20, endS: i * 20 + 10 + i }));
  assert.equal(pickReferenceClips(act, 1200).length, 4);
});

test('nameLabels: nome de referência fica; letra pega quem a linha do tempo cobre', () => {
  const segs = [
    { speaker: 'Leo', start: 0, end: 5, text: 'a' },
    { speaker: 'A', start: 10, end: 20, text: 'b' },
    { speaker: 'B', start: 30, end: 40, text: 'c' },
  ];
  const act = [{ speaker: 'Rodrigo', startS: 240 + 9, endS: 240 + 21 }];
  const m = nameLabels(segs, 240, act, ['Leo'], () => 'X');
  assert.equal(m.get('Leo'), 'Leo');
  assert.equal(m.get('A'), 'Rodrigo');
  assert.equal(m.get('B'), UNKNOWN_SPEAKER, 'ninguém da linha do tempo cobre');
});

test('nameLabels: cobertura < 50% não arrisca nome', () => {
  const m = nameLabels([{ speaker: 'A', start: 0, end: 10, text: 'x' }], 0, [{ speaker: 'Ana', startS: 0, endS: 4 }], [], () => 'X');
  assert.equal(m.get('A'), UNKNOWN_SPEAKER);
});

test('nameLabels: sem linha do tempo usa o fallback', () => {
  const m = nameLabels([{ speaker: 'A', start: 0, end: 10, text: 'x' }], 0, [], [], (l) => `novo:${l}`);
  assert.equal(m.get('A'), 'novo:A');
});

test('corpo do bot: valida e descarta intervalo inválido', () => {
  const r = parseSpeakerActivityBody({
    meeting_id: 281,
    events: [
      { speaker: 'Ana', start_ms: 1000, end_ms: 2000 },
      { speaker: '', start_ms: 1000, end_ms: 2000 },
      { speaker: 'Bia', start_ms: 3000, end_ms: 2000 },
    ],
  });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.events, [{ speaker: 'Ana', startMs: 1000, endMs: 2000 }]);
  assert.deepEqual(parseSpeakerActivityBody({ events: [] }), { ok: false, error: 'meeting_required' });
  assert.deepEqual(
    parseSpeakerActivityBody({ meeting_id: 1, events: Array.from({ length: MAX_EVENTS + 1 }, () => ({})) }),
    { ok: false, error: 'too_many_events' },
  );
});

test('digest: falta de crédito por 75h (caso de 29/09–02/10) ainda retenta', () => {
  const r = nextJobOutcome({ attempts: 1, ageHours: 75, hasTurns: true, errorClass: 'systemic', errorMessage: '429' });
  assert.equal(r.action, 'retry');
});
