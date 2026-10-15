import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intersectOutages, withImplicitOpenOutage } from '../../src/whatsapp/outage-intersection.js';

const o = (s: string, e: string | null) => ({ instance: 'x', startedAt: s, endedAt: e, startedAtSource: 'detected_now', reason: null });

test('uma lista só = ela mesma (relabel)', () => {
  const r = intersectOutages([[o('2026-10-13T00:00:00.000Z', null)]], 'monitor');
  assert.deepEqual(r, [{ instance: 'monitor', startedAt: '2026-10-13T00:00:00.000Z', endedAt: null, startedAtSource: 'intersection', reason: null }]);
});

test('backup vivo durante a queda do A → sem buraco', () => {
  assert.deepEqual(intersectOutages([[o('2026-10-13T00:00:00.000Z', null)], []], 'm'), []);
});

test('sobreposição parcial', () => {
  const r = intersectOutages([
    [o('2026-10-13T00:00:00.000Z', '2026-10-14T00:00:00.000Z')],
    [o('2026-10-13T12:00:00.000Z', null)],
  ], 'm');
  assert.equal(r.length, 1);
  assert.equal(r[0]!.startedAt, '2026-10-13T12:00:00.000Z');
  assert.equal(r[0]!.endedAt, '2026-10-14T00:00:00.000Z');
});

test('os dois abertos → interseção aberta; ordem DESC com vários', () => {
  const r = intersectOutages([
    [o('2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z'), o('2026-10-10T00:00:00.000Z', null)],
    [o('2026-10-01T06:00:00.000Z', '2026-10-01T08:00:00.000Z'), o('2026-10-11T00:00:00.000Z', null)],
  ], 'm');
  assert.deepEqual(r.map((x) => [x.startedAt, x.endedAt]), [
    ['2026-10-11T00:00:00.000Z', null],
    ['2026-10-01T06:00:00.000Z', '2026-10-01T08:00:00.000Z'],
  ]);
});

test('zero listas → []', () => {
  assert.deepEqual(intersectOutages([], 'm'), []);
});

test('número fora sem episódio aberto ganha episódio implícito e preserva o buraco', () => {
  const b = withImplicitOpenOutage([], { instance: 'b', isNumber: true, status: 'connecting', disconnectedSince: '2026-08-18T00:00:00.000Z', fallbackSince: null });
  assert.equal(b.length, 1);
  const r = intersectOutages([[o('2026-10-13T00:00:00.000Z', null)], b], 'm');
  assert.equal(r.length, 1);
  assert.equal(r[0]!.startedAt, '2026-10-13T00:00:00.000Z');
});

test('implícito: conectado, já aberto, ou instância de sistema não alteram', () => {
  const open = [o('2026-10-01T00:00:00.000Z', null)];
  assert.equal(withImplicitOpenOutage([], { instance: 'b', isNumber: true, status: 'connected', disconnectedSince: null, fallbackSince: 'x' }).length, 0);
  assert.equal(withImplicitOpenOutage(open, { instance: 'b', isNumber: true, status: 'close', disconnectedSince: '2026-09-01T00:00:00.000Z', fallbackSince: null }), open);
  assert.equal(withImplicitOpenOutage([], { instance: 'saturno', isNumber: false, status: null, disconnectedSince: null, fallbackSince: null }).length, 0);
});

test('implícito: sem disconnected_since usa o fallback', () => {
  const r = withImplicitOpenOutage([], { instance: 'b', isNumber: true, status: 'connecting', disconnectedSince: null, fallbackSince: '2026-08-20T00:00:00.000Z' });
  assert.equal(r[0]!.startedAt, '2026-08-20T00:00:00.000Z');
});

import { denoiseOutages, OUTAGE_MIN_MS } from '../../src/whatsapp/outage-intersection.js';
const NOW = Date.parse('2026-10-15T22:00:00.000Z');
const ep = (s: string, e: string | null, src = 'webhook') => ({ instance: 'x', startedAt: s, endedAt: e, startedAtSource: src, reason: null });

test('denoise: limiar é 5 min', () => { assert.equal(OUTAGE_MIN_MS, 5 * 60_000); });

test('denoise: queda fechada curta some; longa fica', () => {
  const r = denoiseOutages([
    ep('2026-10-15T21:08:46.000Z', '2026-10-15T21:08:47.000Z'),
    ep('2026-10-15T10:00:00.000Z', '2026-10-15T11:00:00.000Z'),
  ], NOW);
  assert.deepEqual(r.map((x) => x.startedAt), ['2026-10-15T10:00:00.000Z']);
});

test('denoise: aberto há menos de 5 min some; aberto há mais fica', () => {
  assert.deepEqual(denoiseOutages([ep('2026-10-15T21:58:00.000Z', null)], NOW), []);
  assert.equal(denoiseOutages([ep('2026-10-15T21:50:00.000Z', null)], NOW).length, 1);
});

test('denoise: quedas longas separadas por menos de 5 min viram uma; ordem DESC', () => {
  const r = denoiseOutages([
    ep('2026-10-15T12:00:00.000Z', '2026-10-15T12:30:00.000Z'),
    ep('2026-10-15T12:32:00.000Z', null),
    ep('2026-10-15T08:00:00.000Z', '2026-10-15T08:10:00.000Z'),
  ], NOW);
  assert.deepEqual(r.map((x) => [x.startedAt, x.endedAt]), [
    ['2026-10-15T12:00:00.000Z', null],
    ['2026-10-15T08:00:00.000Z', '2026-10-15T08:10:00.000Z'],
  ]);
});

test('denoise: rajada de quedas de segundos (a da disputa de sockets) não vira buraco', () => {
  const burst = Array.from({ length: 50 }, (_, i) => {
    const s = Date.parse('2026-10-15T21:07:00.000Z') + i * 20_000;
    return ep(new Date(s).toISOString(), new Date(s + 2_000).toISOString());
  });
  assert.deepEqual(denoiseOutages(burst, NOW), []);
});
