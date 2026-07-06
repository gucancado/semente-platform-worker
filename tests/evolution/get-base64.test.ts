import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBase64FromMediaMessage } from '../../src/evolution/client.js';

function fakeFetch(captured: any[]) {
  return async (url: string, init: any) => {
    captured.push({ url, init });
    return { ok: true, json: async () => ({ base64: 'QUJD', mimetype: 'audio/ogg' }) } as any;
  };
}

test('POST no endpoint certo com { message } e devolve base64+mimetype', async () => {
  const captured: any[] = [];
  const r = await getBase64FromMediaMessage(
    { baseUrl: 'http://evo', apiKey: 'k', fetch: fakeFetch(captured) as any },
    'inst-1', { key: { id: 'E1' }, message: { audioMessage: {} } });
  assert.equal(r.base64, 'QUJD');
  assert.equal(r.mimetype, 'audio/ogg');
  assert.equal(captured[0].url, 'http://evo/chat/getBase64FromMediaMessage/inst-1');
  assert.deepEqual(JSON.parse(captured[0].init.body), { message: { key: { id: 'E1' }, message: { audioMessage: {} } } });
});

test('base64 ausente vira string vazia (guard no service decide retry)', async () => {
  const r = await getBase64FromMediaMessage(
    { baseUrl: 'http://evo', apiKey: 'k', fetch: (async () => ({ ok: true, json: async () => ({}) })) as any },
    'inst-1', {});
  assert.equal(r.base64, '');
  assert.equal(r.mimetype, null);
});
