import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvolutionInstance, getConnectionState, sendText } from '../../src/evolution/client.js';

function mockFetch(handler: (url: string, init: any) => { status: number; body: any }) {
  return async (url: string, init: any) => {
    const r = handler(url, init);
    return { ok: r.status < 400, status: r.status, json: async () => r.body } as any;
  };
}

test('createEvolutionInstance chama POST /instance/create com apikey', async () => {
  let seen: any = null;
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch((url, init) => { seen = { url, init }; return { status: 200, body: {} }; }) };
  await createEvolutionInstance(deps, 'inst-1');
  assert.match(seen.url, /\/instance\/create$/);
  assert.equal(seen.init.headers['apikey'], 'k');
  assert.equal(JSON.parse(seen.init.body).instanceName, 'inst-1');
});

test('getConnectionState mapeia o estado', async () => {
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch(() => ({ status: 200, body: { instance: { state: 'open' } } })) };
  assert.equal(await getConnectionState(deps, 'inst-1'), 'open');
});

test('sendText retorna sendId', async () => {
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch(() => ({ status: 201, body: { key: { id: 'WMSG1' } } })) };
  assert.deepEqual(await sendText(deps, 'inst-1', '5531', 'oi'), { sendId: 'WMSG1' });
});
