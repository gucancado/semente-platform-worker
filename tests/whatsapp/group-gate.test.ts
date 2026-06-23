// tests/whatsapp/group-gate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceKind, groupAccessAllowed } from '../../src/whatsapp/group-gate.js';

test('coerceKind: flag off força dm independente do pedido', () => {
  assert.equal(coerceKind('all', false), 'dm');
  assert.equal(coerceKind('group', false), 'dm');
  assert.equal(coerceKind('dm', false), 'dm');
  assert.equal(coerceKind(undefined, false), 'dm');
});
test('coerceKind: flag on respeita o pedido (default all)', () => {
  assert.equal(coerceKind('group', true), 'group');
  assert.equal(coerceKind(undefined, true), 'all');
});
test('groupAccessAllowed: grupo só com flag on; dm sempre', () => {
  assert.equal(groupAccessAllowed(true, false), false);
  assert.equal(groupAccessAllowed(true, true), true);
  assert.equal(groupAccessAllowed(false, false), true);
});
