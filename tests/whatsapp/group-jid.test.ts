import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGroupJid } from '../../src/evolution/client.js';

test('normalizeGroupJid remove @g.us e prefixa +', () => {
  assert.equal(normalizeGroupJid('120363098765@g.us'), '+120363098765');
});
test('normalizeGroupJid é idempotente com + já presente', () => {
  assert.equal(normalizeGroupJid('+120363098765'), '+120363098765');
});
test('normalizeGroupJid lida com jid sem sufixo', () => {
  assert.equal(normalizeGroupJid('120363098765'), '+120363098765');
});
