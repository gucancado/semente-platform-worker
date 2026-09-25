// tests/whatsapp/down-notify-probe.test.ts
//
// Teste PURO (fetch falso) do skip combinado de `makeEvolutionProbe`: o store
// lido pela vigia de sistema não pode contar nem o aviso de queda que ela mesma
// manda (isOwnDownNotice) nem qualquer outro tráfego do nosso número Cloud
// (aviso, cópia, sonda — isFromOwnCloudRecord) como sinal de vida do alvo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEvolutionProbe } from '../../src/whatsapp/down-notify-probe.js';

const OWN_PHONE = '553190858510';

test('latestStoreTs pula DM do nosso número Cloud (remoteJidAlt) no topo e acha o tráfego real embaixo', async () => {
  const records = [
    {
      key: { remoteJid: '216578842964141@lid', remoteJidAlt: `${OWN_PHONE}@s.whatsapp.net`, fromMe: false, id: 'sonda-1' },
      message: { conversation: 'Aviso do painel BeeAds: Teste de conexão do WhatsApp X (+551)\nDetalhe: Código P7K3. Não é preciso responder.\nMensagem automática da BeeAds.' },
      messageTimestamp: 1790000000,
    },
    {
      key: { remoteJid: '5531977776666@s.whatsapp.net', fromMe: false, id: 'real-1' },
      message: { conversation: 'oi, quanto custa?' },
      messageTimestamp: 1789990000,
    },
  ];
  const fetch = (async (url: string, init: any) => {
    if (/\/chat\/findMessages\//.test(url)) {
      return { ok: true, status: 200, json: async () => ({ messages: { records, total: records.length, pages: 1 } }) } as any;
    }
    throw new Error(`chamada inesperada: ${url}`);
  }) as any;
  const probe = makeEvolutionProbe({ baseUrl: 'https://evo', apiKey: 'k', fetch }, async () => [], [OWN_PHONE]);
  const ts = await probe.latestStoreTs('inst-1');
  assert.equal(ts!.getTime(), 1789990000 * 1000);
});

test('latestStoreTs pula o aviso de queda (isOwnDownNotice) mesmo sem remoteJidAlt', async () => {
  const records = [
    {
      key: { remoteJid: '93557490733105@lid', fromMe: false, id: 'aviso-1' },
      message: { conversation: 'O WhatsApp Monitor de grupos está desconectado da BeeAds desde 19/09 às 12:03.\n\nhttps://painel.beeads.com.br/reconectar-whatsapp/tok\n\nMensagem automática da BeeAds.' },
      messageTimestamp: 1790000000,
    },
    {
      key: { remoteJid: '120363424016852722@g.us', fromMe: false, id: 'real-1' },
      message: { conversation: 'bom dia, pessoal' },
      messageTimestamp: 1789990000,
    },
  ];
  const fetch = (async (url: string) => {
    if (/\/chat\/findMessages\//.test(url)) {
      return { ok: true, status: 200, json: async () => ({ messages: { records, total: records.length, pages: 1 } }) } as any;
    }
    throw new Error(`chamada inesperada: ${url}`);
  }) as any;
  const probe = makeEvolutionProbe({ baseUrl: 'https://evo', apiKey: 'k', fetch }, async () => [], []);
  const ts = await probe.latestStoreTs('saturno');
  assert.equal(ts!.getTime(), 1789990000 * 1000);
});
