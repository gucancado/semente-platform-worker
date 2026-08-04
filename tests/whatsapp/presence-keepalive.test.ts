import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshPresenceOnce } from '../../src/whatsapp/presence-keepalive.js';

test('reafirma unavailable em TODAS as instâncias conectadas', async () => {
  const touched: string[] = [];
  const r = await refreshPresenceOnce({
    listConnectedInstances: async () => ['inst-a', 'inst-b', 'inst-c'],
    setPresence: async (i) => { touched.push(i); },
  });
  assert.deepEqual(touched, ['inst-a', 'inst-b', 'inst-c']);
  assert.deepEqual(r, { refreshed: 3, failed: 0 });
});

test('instância que falha NÃO impede as demais (best-effort)', async () => {
  const touched: string[] = [];
  const r = await refreshPresenceOnce({
    listConnectedInstances: async () => ['ok-1', 'boom', 'ok-2'],
    setPresence: async (i) => {
      if (i === 'boom') throw new Error('Evolution POST /instance/setPresence/boom → 400');
      touched.push(i);
    },
  });
  assert.deepEqual(touched, ['ok-1', 'ok-2']);
  assert.deepEqual(r, { refreshed: 2, failed: 1 });
});

test('sem instância conectada é no-op (não chama a Evolution)', async () => {
  let calls = 0;
  const r = await refreshPresenceOnce({
    listConnectedInstances: async () => [],
    setPresence: async () => { calls++; },
  });
  assert.equal(calls, 0);
  assert.deepEqual(r, { refreshed: 0, failed: 0 });
});
