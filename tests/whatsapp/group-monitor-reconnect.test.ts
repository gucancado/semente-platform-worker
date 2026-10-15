import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMonitorSlot, issueMonitorReconnectLink } from '../../src/whatsapp/group-monitor-reconnect.js';

test('parseMonitorSlot: só A/B, case-insensitive', () => {
  assert.equal(parseMonitorSlot('A'), 'A');
  assert.equal(parseMonitorSlot('b'), 'B');
  assert.equal(parseMonitorSlot('C'), null);
  assert.equal(parseMonitorSlot(''), null);
  assert.equal(parseMonitorSlot(undefined), null);
  assert.equal(parseMonitorSlot('AB'), null);
});

const pool = (rows: any[]) => ({ query: async () => ({ rows }) }) as any;

test('issue: instância e telefone vêm do SLOT, label do monitor, link reaproveitado', async () => {
  let got: any = null;
  const r = await issueMonitorReconnectLink(
    pool([{ slot: 'B', instance: 'ws-a6908c04-24bd8aa8', phone: '+553196039118' }]),
    'B', 'user-1',
    async (_p, args) => { got = args; return { row: { token: 'T', expiresAt: '2026-10-22T00:00:00.000Z' } as any, reused: true }; },
  );
  assert.deepEqual(r, { token: 'T', expiresAt: '2026-10-22T00:00:00.000Z', reused: true, label: 'Monitor de grupos B' });
  assert.equal(got.instance, 'ws-a6908c04-24bd8aa8');
  assert.equal(got.expectedPhone, '+553196039118');
  assert.equal(got.label, 'Monitor de grupos B');
  assert.equal(got.workspaceId, null);
  assert.equal(got.createdBy, 'user-1');
});

test('issue: slot sem linha → null', async () => {
  const r = await issueMonitorReconnectLink(pool([]), 'A', null, async () => { throw new Error('não deveria'); });
  assert.equal(r, null);
});
