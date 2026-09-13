import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION_DOWN_TEMPLATE,
  RECONNECT_URL_BASE,
  connectionDownTemplateParams,
  renderConnectionDownText,
} from '../../src/webhook-cloud/templates.js';
import { DEFAULT_PANEL_PUBLIC_URL, reconnectUrl } from '../../src/whatsapp/down-notify.js';

const body = CONNECTION_DOWN_TEMPLATE.components.find((c) => c.type === 'BODY')!;
const vars = body.text.match(/\{\{\d+\}\}/g) ?? [];

test('template é UTILITY em pt_BR', () => {
  assert.equal(CONNECTION_DOWN_TEMPLATE.category, 'UTILITY');
  assert.equal(CONNECTION_DOWN_TEMPLATE.language, 'pt_BR');
});

test('sem botão: o link vai no corpo para sobreviver ao encaminhamento', () => {
  assert.deepEqual(CONNECTION_DOWN_TEMPLATE.components.map((c) => c.type), ['BODY']);
  assert.ok(body.text.includes(`${RECONNECT_URL_BASE}{{3}}`));
});

test('corpo não começa nem termina com variável (regra de aprovação da Meta)', () => {
  assert.doesNotMatch(body.text, /^\s*\{\{/);
  assert.doesNotMatch(body.text, /\}\}\s*$/);
});

test('exemplo do corpo cobre exatamente as variáveis declaradas', () => {
  assert.equal(body.example.body_text[0].length, vars.length);
});

test('base do link é a MESMA URL de reconexão do painel', () => {
  assert.equal(`${RECONNECT_URL_BASE}tok`, reconnectUrl(DEFAULT_PANEL_PUBLIC_URL, 'tok'));
});

test('parâmetros casam em número e ordem com as variáveis do template (drift)', () => {
  const p = connectionDownTemplateParams({
    name: 'Monitor de grupos',
    phone: '+553195950748',
    downSince: new Date('2026-09-09T21:10:00.000Z'),
    token: 'tok123',
  });
  assert.equal(p.bodyParams.length, vars.length);
  assert.deepEqual(p.bodyParams, ['Monitor de grupos (+553195950748)', '09/09 às 18:10', 'tok123']);
});

test('sem nome o primeiro parâmetro é só o telefone', () => {
  const p = connectionDownTemplateParams({ name: null, phone: '+5531999', downSince: new Date(), token: 't' });
  assert.equal(p.bodyParams[0], '+5531999');
});

test('parâmetro de corpo não leva quebra de linha, tab nem espaço repetido (Meta recusa)', () => {
  const p = connectionDownTemplateParams({
    name: 'Linha 1\nLinha\t2     fim',
    phone: '+5531999',
    downSince: new Date(),
    token: 't',
  });
  assert.doesNotMatch(p.bodyParams[0], /[\n\t]| {2,}/);
});

test('texto renderizado é o corpo aprovado com as variáveis preenchidas', () => {
  const text = renderConnectionDownText({
    name: 'Pousada Recanto de Moriá',
    phone: '+5524999422282',
    downSince: new Date('2026-09-09T18:32:00.000Z'),
    token: 'tok123',
  });
  assert.equal(
    text,
    'O WhatsApp Pousada Recanto de Moriá (+5524999422282) está desconectado da BeeAds desde 09/09 às 15:32.\n\n' +
      'Para reconectar, abra o link abaixo em outra tela e escaneie o QR com este celular em ' +
      '*Configurações > Dispositivos conectados*\n\n' +
      'https://painel.beeads.com.br/reconectar-whatsapp/tok123\n\n' +
      'Mensagem automática da BeeAds.',
  );
});
