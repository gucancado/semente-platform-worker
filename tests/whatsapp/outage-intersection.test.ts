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
