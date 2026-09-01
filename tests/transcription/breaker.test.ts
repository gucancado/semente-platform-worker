import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCircuitBreaker } from '../../src/transcription/breaker.js';

test('nasce fechado — fila roda normalmente', () => {
  const b = createCircuitBreaker({ cooldownMs: 600_000 });
  assert.equal(b.isOpen(1_000), false);
});

test('falha sistêmica abre o breaker pelo cooldown', () => {
  const b = createCircuitBreaker({ cooldownMs: 600_000 });
  b.trip('429 no credits', 1_000);
  assert.equal(b.isOpen(1_000), true);
  assert.equal(b.isOpen(600_999), true);
});

test('fecha sozinho quando o cooldown vence — a recuperação não depende de ninguém', () => {
  const b = createCircuitBreaker({ cooldownMs: 600_000 });
  b.trip('429 no credits', 1_000);
  assert.equal(b.isOpen(601_001), false);
});

test('trip repetido estende a pausa a partir do instante novo', () => {
  const b = createCircuitBreaker({ cooldownMs: 600_000 });
  b.trip('429', 1_000);
  b.trip('429', 300_000);
  assert.equal(b.isOpen(700_000), true); // ainda pausado: 300_000 + 600_000
});

test('reporta o motivo e o instante de reabertura para o log', () => {
  const b = createCircuitBreaker({ cooldownMs: 60_000 });
  b.trip('503 Service Unavailable', 5_000);
  const s = b.state();
  assert.equal(s.reason, '503 Service Unavailable');
  assert.equal(s.openUntil, 65_000);
});

test('consecutivos conta quantas rajadas sistêmicas houve — sinal de apagão longo', () => {
  const b = createCircuitBreaker({ cooldownMs: 60_000 });
  b.trip('429', 1_000);
  b.trip('429', 2_000);
  assert.equal(b.state().consecutive, 2);
});

test('sucesso zera o contador — apagão terminou', () => {
  const b = createCircuitBreaker({ cooldownMs: 60_000 });
  b.trip('429', 1_000);
  b.recordSuccess();
  assert.equal(b.state().consecutive, 0);
});
