import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signEvent, verifyEventSignature } from '../../src/events/signature.js';

test('assinatura é determinística sobre event_id.timestamp.body', () => {
  const sig = signEvent('s3cr3t', '42', '2026-06-10T12:00:00.000Z', '{"a":1}');
  assert.equal(sig, signEvent('s3cr3t', '42', '2026-06-10T12:00:00.000Z', '{"a":1}'));
  assert.notEqual(sig, signEvent('s3cr3t', '43', '2026-06-10T12:00:00.000Z', '{"a":1}'));
});

test('verify aceita secret ativo OU anterior (rotação)', () => {
  const ts = new Date().toISOString();
  const sig = signEvent('old-secret', '1', ts, 'body');
  assert.equal(verifyEventSignature(['new-secret', 'old-secret'], sig, '1', ts, 'body'), true);
  assert.equal(verifyEventSignature(['new-secret'], sig, '1', ts, 'body'), false);
});

test('verify rejeita timestamp fora de ±5min', () => {
  const old = new Date(Date.now() - 6 * 60_000).toISOString();
  const sig = signEvent('s', '1', old, 'body');
  assert.equal(verifyEventSignature(['s'], sig, '1', old, 'body'), false);
});
