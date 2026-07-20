import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLinkToken, computeLinkState, type ProvisionLinkRow } from '../../src/whatsapp/provision-links.js';

function row(over: Partial<ProvisionLinkRow>): ProvisionLinkRow {
  return {
    token: 't', workspaceId: 'ws', createdBy: null, maxClicks: 10, clicksUsed: 0,
    status: 'active', consumedAt: null, connectedNumberId: null,
    createdAt: '2026-07-19T00:00:00.000Z', expiresAt: '2026-07-26T00:00:00.000Z', ...over,
  };
}
const NOW = new Date('2026-07-20T00:00:00.000Z').getTime();

test('token tem 43 chars base64url (32 bytes) e é único', () => {
  const a = generateLinkToken(), b = generateLinkToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});

test('active quando dentro do prazo e cliques abaixo do limite', () => {
  assert.equal(computeLinkState(row({}), NOW), 'active');
});

test('expired por tempo mesmo com status active persistido', () => {
  assert.equal(computeLinkState(row({ expiresAt: '2026-07-19T12:00:00.000Z' }), NOW), 'expired');
});

test('exhausted quando clicks atingem o max', () => {
  assert.equal(computeLinkState(row({ clicksUsed: 10 }), NOW), 'exhausted');
});

test('status persistido consumed/exhausted/expired prevalece', () => {
  assert.equal(computeLinkState(row({ status: 'consumed' }), NOW), 'consumed');
  assert.equal(computeLinkState(row({ status: 'exhausted' }), NOW), 'exhausted');
});
