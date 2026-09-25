import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvolutionInstance, getConnectionState, sendText, ensureEvolutionInstance, setPresenceUnavailable, fetchGroupParticipants, fetchLatestMessageTs } from '../../src/evolution/client.js';

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

test('fetchLatestMessageTs pede 1 registro e converte segundos em Date', async () => {
  let seen: any = null;
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch((url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return { status: 200, body: { messages: { records: [{ messageTimestamp: 1789218267 }], total: 9, pages: 9 } } };
  }) };
  const ts = await fetchLatestMessageTs(deps, 'saturno');
  assert.equal(ts!.toISOString(), new Date(1789218267 * 1000).toISOString());
  assert.match(seen.url, /\/chat\/findMessages\/saturno$/);
  assert.deepEqual(seen.body, { where: {}, page: 1, offset: 1 });
});

test('fetchLatestMessageTs com `skip` varre uma página e devolve o primeiro registro que NÃO é pulado', async () => {
  let seen: any = null;
  const records = [
    { key: { id: 'aviso-2' }, messageTimestamp: 1789900481 },
    { key: { id: 'aviso-1' }, messageTimestamp: 1789836579 },
    { key: { id: 'real' }, messageTimestamp: 1789755600 },
  ];
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch((url, init) => {
    seen = JSON.parse(init.body);
    return { status: 200, body: { messages: { records } } };
  }) };
  const ts = await fetchLatestMessageTs(deps, 'saturno', { skip: (r: any) => String(r?.key?.id).startsWith('aviso') });
  assert.equal(ts!.getTime(), 1789755600 * 1000);
  // uma chamada só, com página larga o bastante para passar por cima dos avisos de um episódio
  assert.deepEqual(seen, { where: {}, page: 1, offset: 20 });
});

test('fetchLatestMessageTs com `skip`: página inteira pulada é store sem tráfego', async () => {
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch(() => ({ status: 200, body: { messages: { records: [{ messageTimestamp: 1789900481 }] } } })) };
  assert.equal(await fetchLatestMessageTs(deps, 'i', { skip: () => true }), null);
});

test('fetchLatestMessageTs aceita timestamp em string', async () => {
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch(() => ({ status: 200, body: { messages: { records: [{ messageTimestamp: '1789218267' }] } } })) };
  assert.equal((await fetchLatestMessageTs(deps, 'i'))!.getTime(), 1789218267 * 1000);
});

test('fetchLatestMessageTs com store vazio ou timestamp ilegível devolve null', async () => {
  const empty = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch(() => ({ status: 200, body: { messages: { records: [] } } })) };
  assert.equal(await fetchLatestMessageTs(empty, 'i'), null);
  const junk = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch(() => ({ status: 200, body: { messages: { records: [{ messageTimestamp: { low: 1, high: 0 } }] } } })) };
  assert.equal(await fetchLatestMessageTs(junk, 'i'), null);
});

// Sonda: sondas + avisos podem ocupar o TOPO do store inteiro de um número
// quieto (mais de 20 registros no topo) — precisa paginar por cima delas.
test('fetchLatestMessageTs com `skip` pagina até achar tráfego real quando a 1ª página inteira é pulada', async () => {
  const page1 = Array.from({ length: 20 }, (_, i) => ({ key: { id: `aviso-${i}` }, messageTimestamp: 1789900000 - i }));
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch((_url, init) => {
    const body = JSON.parse(init.body);
    if (body.page === 1) return { status: 200, body: { messages: { records: page1 } } };
    return { status: 200, body: { messages: { records: [{ key: { id: 'real' }, messageTimestamp: 1790000000 }] } } };
  }) };
  const ts = await fetchLatestMessageTs(deps, 'saturno', { skip: (r: any) => String(r?.key?.id).startsWith('aviso') });
  assert.equal(ts!.getTime(), 1790000000 * 1000);
});

test('fetchLatestMessageTs com `skip`: 5 páginas todas puladas devolve null (não fica preso)', async () => {
  let calls = 0;
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch(() => {
    calls++;
    return { status: 200, body: { messages: { records: [{ key: { id: 'aviso' }, messageTimestamp: 1789900000 }] } } };
  }) };
  const ts = await fetchLatestMessageTs(deps, 'saturno', { skip: (r: any) => String(r?.key?.id).startsWith('aviso') });
  assert.equal(ts, null);
  assert.equal(calls, 5);
});

// Task 5: Chamadas Evolution com timeout (ler, arquivar, dono, busca no store)
import { markMessageAsRead, archiveChat, fetchInstanceOwner, findProbeInStore, type MessageKey } from '../../src/evolution/client.js';

test('markMessageAsRead faz POST /chat/markMessageAsRead/i1 com {readMessages:[key]}', async () => {
  let seen: any = null;
  const key: MessageKey = { id: 'msg-1', remoteJid: '+551199999999@s.whatsapp.net', fromMe: false };
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch((url, init) => { seen = { url, init }; return { status: 200, body: {} }; }) };
  await markMessageAsRead(deps, 'i1', key);
  assert.match(seen.url, /\/chat\/markMessageAsRead\/i1$/);
  assert.equal(seen.init.method, 'POST');
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.readMessages, [key]);
});

test('archiveChat faz POST /chat/archiveChat/i1 com {lastMessage:{key}, chat:key.remoteJid, archive:true}', async () => {
  let seen: any = null;
  const key: MessageKey = { id: 'msg-2', remoteJid: '+551199999999@s.whatsapp.net', fromMe: false };
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch((url, init) => { seen = { url, init }; return { status: 200, body: {} }; }) };
  await archiveChat(deps, 'i1', key);
  assert.match(seen.url, /\/chat\/archiveChat\/i1$/);
  assert.equal(seen.init.method, 'POST');
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body, { lastMessage: { key }, chat: key.remoteJid, archive: true });
});

test('fetchInstanceOwner extrai dígitos do ownerJid', async () => {
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch(() => ({ status: 200, body: [{ ownerJid: '553171070896@s.whatsapp.net' }] })) };
  const owner = await fetchInstanceOwner(deps, 'i1');
  assert.equal(owner, '553171070896');
});

test('fetchInstanceOwner devolve null se ownerJid não está presente', async () => {
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch(() => ({ status: 200, body: [{}] })) };
  const owner = await fetchInstanceOwner(deps, 'i1');
  assert.equal(owner, null);
});

test('findProbeInStore acha o código na 2ª página', async () => {
  let pagesSeen: number[] = [];
  const deps = {
    baseUrl: 'https://evo',
    apiKey: 'k',
    fetch: mockFetch((url, init) => {
      const body = JSON.parse(init.body);
      pagesSeen.push(body.page);
      if (body.page === 1) {
        // Full page of non-matching records (50 = PROBE_SCAN_PAGE)
        return {
          status: 200,
          body: {
            messages: {
              records: Array.from({ length: 50 }, (_, i) => ({
                messageTimestamp: 1700000000 + i,
                message: { conversation: `msg ${i}` },
              })),
            },
          },
        };
      } else if (body.page === 2) {
        return {
          status: 200,
          body: {
            messages: {
              records: [
                { messageTimestamp: 1700100000, message: { conversation: 'Teste de conexão do WhatsApp probe. Código AB2C.' } },
              ],
            },
          },
        };
      }
      return { status: 200, body: { messages: { records: [] } } };
    }),
  };
  const found = await findProbeInStore(deps, 'i1', 'AB2C', 1699999000);
  assert.equal(found, true);
  assert.ok(pagesSeen.includes(1));
  assert.ok(pagesSeen.includes(2));
});

test('findProbeInStore para quando messageTimestamp < sinceSec', async () => {
  let pagesSeen: number[] = [];
  const deps = {
    baseUrl: 'https://evo',
    apiKey: 'k',
    fetch: mockFetch((url, init) => {
      const body = JSON.parse(init.body);
      pagesSeen.push(body.page);
      return {
        status: 200,
        body: {
          messages: {
            records: [{ messageTimestamp: 1700000000, message: { conversation: 'old' } }],
          },
        },
      };
    }),
  };
  const found = await findProbeInStore(deps, 'i1', 'AB2C', 1700100000);
  assert.equal(found, false);
  assert.deepEqual(pagesSeen, [1]);
});

test('Chamadas com status >= 400 lançam Error com status', async () => {
  const key: MessageKey = { id: 'msg-3', remoteJid: '+551199999999@s.whatsapp.net', fromMe: false };
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: mockFetch(() => ({ status: 401, body: {} })) };
  await assert.rejects(() => markMessageAsRead(deps, 'i1', key), /401/);
  await assert.rejects(() => archiveChat(deps, 'i1', key), /401/);
  await assert.rejects(() => fetchInstanceOwner(deps, 'i1'), /401/);
  await assert.rejects(() => findProbeInStore(deps, 'i1', 'XXXX', 0), /401/);
});

test('findProbeInStore com 200 non-JSON body rejeita (não discard)', async () => {
  const deps = {
    baseUrl: 'https://evo',
    apiKey: 'k',
    fetch: (async (url: string, init: any) => {
      return { ok: true, status: 200, json: async () => { throw new Error('invalid json'); } } as any;
    }) as any,
  };
  await assert.rejects(() => findProbeInStore(deps, 'i1', 'AB2C', 0), /invalid json/);
});

test('findProbeInStore: matching record com timestamp < sinceSec ainda retorna true (checa antes de parar)', async () => {
  const deps = {
    baseUrl: 'https://evo',
    apiKey: 'k',
    fetch: mockFetch((url, init) => {
      const body = JSON.parse(init.body);
      if (body.page === 1) {
        return {
          status: 200,
          body: {
            messages: {
              records: [
                { messageTimestamp: 1699999000, message: { conversation: 'Teste de conexão do WhatsApp probe. Código XY5Z.' } },
              ],
            },
          },
        };
      }
      return { status: 200, body: { messages: { records: [] } } };
    }),
  };
  const found = await findProbeInStore(deps, 'i1', 'XY5Z', 1700100000);
  assert.equal(found, true);
});

test('Todas as chamadas de timeout incluem AbortSignal.timeout', async () => {
  let seenInit: any = null;
  const key: MessageKey = { id: 'msg-4', remoteJid: '+551199999999@s.whatsapp.net', fromMe: false };
  const deps = {
    baseUrl: 'https://evo',
    apiKey: 'k',
    fetch: (async (url: string, init: any) => {
      seenInit = init;
      return { ok: true, status: 200, json: async () => ({}) } as any;
    }) as any,
  };
  await markMessageAsRead(deps, 'i1', key);
  assert.ok(seenInit.signal instanceof AbortSignal);
});

test('findProbeInStore pede offset: 50 (PROBE_SCAN_PAGE)', async () => {
  let seenBody: any = null;
  const deps = {
    baseUrl: 'https://evo',
    apiKey: 'k',
    fetch: mockFetch((url, init) => {
      seenBody = JSON.parse(init.body);
      return { status: 200, body: { messages: { records: [] } } };
    }),
  };
  await findProbeInStore(deps, 'i1', 'AB2C', 0);
  assert.equal(seenBody.offset, 50);
});

test('findProbeInStore para após 5 páginas mesmo com todas cheias e sem match', async () => {
  let pageCount = 0;
  const deps = {
    baseUrl: 'https://evo',
    apiKey: 'k',
    fetch: mockFetch((url, init) => {
      const body = JSON.parse(init.body);
      pageCount = Math.max(pageCount, body.page);
      const records = Array.from({ length: 50 }, (_, i) => ({
        messageTimestamp: 1700000000 + i,
        message: { conversation: `msg ${i}` },
      }));
      return { status: 200, body: { messages: { records } } };
    }),
  };
  const found = await findProbeInStore(deps, 'i1', 'NOMATCH', 0);
  assert.equal(found, false);
  assert.equal(pageCount, 5);
});

test('findProbeInStore para cedo se página tem < 50 records (fim da loja)', async () => {
  let pageCount = 0;
  const deps = {
    baseUrl: 'https://evo',
    apiKey: 'k',
    fetch: mockFetch((url, init) => {
      const body = JSON.parse(init.body);
      pageCount = Math.max(pageCount, body.page);
      if (body.page === 1) {
        return { status: 200, body: { messages: { records: Array.from({ length: 49 }, (_, i) => ({ messageTimestamp: 1700000000 + i, message: {} })) } } };
      }
      return { status: 200, body: { messages: { records: [] } } };
    }),
  };
  const found = await findProbeInStore(deps, 'i1', 'NOMATCH', 0);
  assert.equal(found, false);
  assert.equal(pageCount, 1);
});
