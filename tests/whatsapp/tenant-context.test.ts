import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenantContext } from '../../src/whatsapp/tenant-context.js';
import type { WhatsappNumber } from '../../src/whatsapp/numbers.js';

const num: WhatsappNumber = {
  id: 7, workspaceId: 'ws-1', phone: '+5511999998888', evolutionInstance: 'inst',
  label: 'Comercial SP', status: 'connected', mode: 'monitored', exposeGroupsInMcp: false,
  createdBy: null, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
  removedAt: null,
};

test('tenantContext(WhatsappNumber) → workspaceId + number completo', () => {
  assert.deepEqual(tenantContext(num), {
    workspaceId: 'ws-1',
    number: { id: 7, label: 'Comercial SP', phone: '+5511999998888' },
  });
});

test('tenantContext({ workspaceId }) → number null', () => {
  assert.deepEqual(tenantContext({ workspaceId: 'ws-9' }), { workspaceId: 'ws-9', number: null });
});

test('tenantContext preserva label/phone null', () => {
  const n = { ...num, label: null, phone: null };
  assert.deepEqual(tenantContext(n).number, { id: 7, label: null, phone: null });
});
