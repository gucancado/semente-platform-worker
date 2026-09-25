import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OWN_TEMPLATE_IDS, extractProbeCode, isFromOwnCloudRecord, ownCloudText, parseOwnPhones,
} from '../../src/whatsapp/own-cloud.js';
import { renderConnectionDownText } from '../../src/webhook-cloud/templates.js';

const OWN = parseOwnPhones('+553190858510');
const probeMsg = (templateId = '1896879847947648', text =
  'Aviso do painel BeeAds: Teste de conexão do WhatsApp Operação BeeAds (+553171070896)\nDetalhe: Código P7K3. Não é preciso responder.\nMensagem automática da BeeAds.') => ({
  templateMessage: { templateId, hydratedTemplate: { templateId, hydratedContentText: text, hydratedButtons: [] } },
  messageContextInfo: {},
});

test('parseOwnPhones: dígitos, ignora vazio', () => {
  assert.deepEqual(parseOwnPhones('+553190858510, 5531 99999-0000 ,'), ['553190858510', '5531999990000']);
  assert.deepEqual(parseOwnPhones(undefined), []);
});

test('ownCloudText lê hydratedContentText', () => {
  assert.match(ownCloudText(probeMsg())!, /Código P7K3/);
  assert.equal(ownCloudText({ conversation: 'oi' }), 'oi');
  assert.equal(ownCloudText(null), null);
});

test('extractProbeCode', () => {
  assert.equal(extractProbeCode(ownCloudText(probeMsg())), 'P7K3');
  assert.equal(extractProbeCode('Código ABC. qualquer'), null);
  assert.equal(extractProbeCode(null), null);
});

test('DM com remoteJidAlt do nosso número é nossa', () => {
  const rec = { key: { remoteJid: '216578842964141@lid', remoteJidAlt: '553190858510@s.whatsapp.net', fromMe: false }, message: { conversation: 'x' } };
  assert.equal(isFromOwnCloudRecord(rec, OWN), true);
});

test('LID sem alt: reconhece pelo templateId', () => {
  const rec = { key: { remoteJid: '216578842964141@lid', fromMe: false }, message: probeMsg('1620869592995276', 'qualquer') };
  assert.equal(isFromOwnCloudRecord(rec, OWN), true);
  assert.ok(OWN_TEMPLATE_IDS.includes('1620869592995276'));
});

test('LID sem alt e template desconhecido: reconhece pelo marcador da sonda', () => {
  const rec = { key: { remoteJid: '216578842964141@lid', fromMe: false }, message: probeMsg('999') };
  assert.equal(isFromOwnCloudRecord(rec, OWN), true);
});

test('9º dígito: 5531990858510 também é nosso', () => {
  const rec = { key: { remoteJid: '5531990858510@s.whatsapp.net', fromMe: false }, message: { conversation: 'x' } };
  assert.equal(isFromOwnCloudRecord(rec, OWN), true);
});

test('LID sem alt: aviso de queda entregue como texto plano (conversation) também é nosso', () => {
  // Medido: o Baileys pode entregar o aviso (ou a cópia ao operador) como
  // conversation/extendedTextMessage puro numa DM em LID sem remoteJidAlt —
  // escapando das outras 3 regras (telefone, templateId, marcador da sonda).
  // Só o CONTEÚDO (isOwnDownNotice) prova a origem nesse caso.
  const noticeText = renderConnectionDownText({
    name: 'Monitor de grupos',
    phone: '+553195950748',
    downSince: new Date('2026-09-19T12:03:00-03:00'),
    token: 'o4MEzz_exemploDeToken',
  });
  const rec = { key: { remoteJid: '216578842964141@lid', fromMe: false }, message: { conversation: noticeText } };
  assert.equal(isFromOwnCloudRecord(rec, OWN), true);
});

test('LID sem alt: reconhece templateId em hydratedFourRowTemplate (variante do template)', () => {
  const rec = {
    key: { remoteJid: '216578842964141@lid', fromMe: false },
    message: { templateMessage: { hydratedFourRowTemplate: { templateId: '1620869592995276' } } },
  };
  assert.equal(isFromOwnCloudRecord(rec, OWN), true);
});

test('grupo, fromMe e terceiro NÃO são nossos', () => {
  const grp = { key: { remoteJid: '1203@g.us', participantAlt: '553190858510@s.whatsapp.net', fromMe: false }, message: probeMsg() };
  const mine = { key: { remoteJid: '553190858510@s.whatsapp.net', fromMe: true }, message: { conversation: 'x' } };
  const other = { key: { remoteJid: '553199999999@s.whatsapp.net', fromMe: false }, message: { conversation: 'Código P7K3.' } };
  assert.equal(isFromOwnCloudRecord(grp, OWN), false);
  assert.equal(isFromOwnCloudRecord(mine, OWN), false);
  assert.equal(isFromOwnCloudRecord(other, OWN), false);
});
