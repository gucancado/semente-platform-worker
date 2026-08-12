import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvolutionInstance, getConnectionState, sendText, ensureEvolutionInstance, setPresenceUnavailable, fetchGroupParticipants } from '../../src/evolution/client.js';

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

test('ensureEvolutionInstance: create OK → registra webhook', async () => {
  const calls: string[] = [];
  const deps = { baseUrl: 'http://m', apiKey: 'k', fetch: (async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({}) } as any;
  }) as any };
  await ensureEvolutionInstance(deps, 'inst-1', { url: 'http://wk', secret: 's' });
  assert.ok(calls.some((u) => /\/instance\/create$/.test(u)));
  assert.ok(calls.some((u) => /\/webhook\/set\/inst-1$/.test(u)));
});

test('ensureEvolutionInstance: create falha mas instância existe (connectionState OK) → segue e registra webhook', async () => {
  const calls: string[] = [];
  const deps = { baseUrl: 'http://m', apiKey: 'k', fetch: (async (url: string) => {
    calls.push(url);
    if (/\/instance\/create$/.test(url)) return { ok: false, status: 403, json: async () => ({}) } as any;
    return { ok: true, status: 200, json: async () => ({ instance: { state: 'connecting' } }) } as any;
  }) as any };
  await ensureEvolutionInstance(deps, 'inst-2', { url: 'http://wk', secret: 's' });
  assert.ok(calls.some((u) => /\/instance\/connectionState\/inst-2$/.test(u)));
  assert.ok(calls.some((u) => /\/webhook\/set\/inst-2$/.test(u)));
});

test('ensureEvolutionInstance: create falha E instância não existe → propaga erro', async () => {
  const deps = { baseUrl: 'http://m', apiKey: 'k', fetch: (async (url: string) => {
    return { ok: false, status: 500, json: async () => ({}) } as any;
  }) as any };
  await assert.rejects(() => ensureEvolutionInstance(deps, 'inst-3', { url: 'http://wk', secret: 's' }));
});

test('setPresenceUnavailable posta presence=unavailable no endpoint da instância', async () => {
  let seen: any = null;
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch((url, init) => { seen = { url, init }; return { status: 201, body: { presence: 'unavailable' } }; }) };
  await setPresenceUnavailable(deps, 'inst-1');
  assert.match(seen.url, /\/instance\/setPresence\/inst-1$/);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['apikey'], 'k');
  assert.equal(JSON.parse(seen.init.body).presence, 'unavailable');
});

// Shape MEDIDO em produção (instância 'saturno'):
// GET /group/participants/saturno?groupJid=<digitos>@g.us →
// {"participants":[{"id":"166730898927796@lid","phoneNumber":"553196039118@s.whatsapp.net","admin":"admin","name":"Gustavo Cançado","imgUrl":"..."}]}
test('fetchGroupParticipants monta a URL sem "+" e com "@g.us", e parseia o roster', async () => {
  let seenUrl = '';
  let seenInit: any = null;
  const deps = {
    baseUrl: 'https://evo', apiKey: 'k',
    fetch: (async (url: string, init: any) => {
      seenUrl = url;
      seenInit = init;
      return {
        ok: true, status: 200,
        json: async () => ({
          participants: [{
            id: '166730898927796@lid', phoneNumber: '553196039118@s.whatsapp.net',
            admin: 'admin', name: 'Gustavo Cançado', imgUrl: 'https://pps.whatsapp.net/x',
          }],
        }),
      } as any;
    }) as any,
  };
  const out = await fetchGroupParticipants(deps, 'saturno', '+120363001234567890');
  assert.equal(seenUrl, 'https://evo/group/participants/saturno?groupJid=120363001234567890@g.us', 'jid interno perde o "+" e ganha "@g.us"');
  assert.equal(seenInit.method, 'GET');
  assert.equal(seenInit.headers['apikey'], 'k');
  assert.deepEqual(out, [{
    phone: '+553196039118', isAdmin: true, isLid: false, lid: '166730898927796', pushName: 'Gustavo Cançado',
  }]);
});

test('fetchGroupParticipants trata 404 como roster vazio, não como falha', async () => {
  const deps = {
    baseUrl: 'https://evo', apiKey: 'k',
    fetch: (async () => ({ ok: false, status: 404, json: async () => ({ error: 'not found' }) })) as any,
  };
  assert.deepEqual(await fetchGroupParticipants(deps, 'saturno', '+120363001'), []);
});

test('fetchGroupParticipants propaga erro em status de falha diferente de 404', async () => {
  const deps = {
    baseUrl: 'https://evo', apiKey: 'k',
    fetch: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any,
  };
  await assert.rejects(() => fetchGroupParticipants(deps, 'saturno', '+120363001'), /500/);
});

test('ensureEvolutionInstance: webhook falha após create → rollback (deleteInstance) e propaga', async () => {
  const calls: string[] = [];
  const deps = { baseUrl: 'http://m', apiKey: 'k', fetch: (async (url: string, init: any) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (/\/webhook\/set\//.test(url)) return { ok: false, status: 500, json: async () => ({}) } as any;
    return { ok: true, status: 200, json: async () => ({}) } as any;
  }) as any };
  await assert.rejects(() => ensureEvolutionInstance(deps, 'inst-4', { url: 'http://wk', secret: 's' }));
  assert.ok(calls.some((c) => /DELETE .*\/instance\/delete\/inst-4$/.test(c)));
});
