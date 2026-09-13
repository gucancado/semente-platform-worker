import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION_DOWN_TEMPLATE,
  RECONNECT_URL_BASE,
  connectionDownTemplateParams,
} from '../../src/webhook-cloud/templates.js';
import { DEFAULT_PANEL_PUBLIC_URL, reconnectUrl } from '../../src/whatsapp/down-notify.js';

const body = CONNECTION_DOWN_TEMPLATE.components.find((c) => c.type === 'BODY') as { text: string; example: { body_text: string[][] } };
const buttons = CONNECTION_DOWN_TEMPLATE.components.find((c) => c.type === 'BUTTONS') as {
  buttons: Array<{ type: string; url: string; example: string[] }>;
};

test('template é UTILITY em pt_BR', () => {
  assert.equal(CONNECTION_DOWN_TEMPLATE.category, 'UTILITY');
  assert.equal(CONNECTION_DOWN_TEMPLATE.language, 'pt_BR');
});

test('corpo não começa nem termina com variável (regra de aprovação da Meta)', () => {
  assert.doesNotMatch(body.text, /^\s*\{\{/);
  assert.doesNotMatch(body.text, /\}\}\s*$/);
});

test('exemplo do corpo cobre exatamente as variáveis declaradas', () => {
  const vars = body.text.match(/\{\{\d+\}\}/g) ?? [];
  assert.equal(body.example.body_text[0].length, vars.length);
});

test('botão de URL termina na variável e o exemplo usa a mesma base', () => {
  const b = buttons.buttons[0];
  assert.equal(b.type, 'URL');
  assert.equal(b.url, `${RECONNECT_URL_BASE}{{1}}`);
  assert.ok(b.example[0].startsWith(RECONNECT_URL_BASE));
});

test('base do botão é a MESMA URL de reconexão que o texto livre usa', () => {
  // A base fica congelada na aprovação da Meta; divergir do link do texto
  // faria template e fallback apontarem para lugares diferentes.
  assert.equal(`${RECONNECT_URL_BASE}tok`, reconnectUrl(DEFAULT_PANEL_PUBLIC_URL, 'tok'));
});

test('parâmetros casam em número com as variáveis do template (drift)', () => {
  const p = connectionDownTemplateParams({
    label: 'Monitor de grupos',
    phone: '+553195950748',
    downSince: new Date('2026-09-09T21:10:00.000Z'),
    token: 'tok123',
  });
  const vars = body.text.match(/\{\{\d+\}\}/g) ?? [];
  assert.equal(p.bodyParams.length, vars.length);
  assert.equal(p.bodyParams[0], 'Monitor de grupos (+553195950748)');
  assert.equal(p.bodyParams[1], '09/09 às 18:10');
  assert.equal(p.urlButtonParam, 'tok123');
});

test('sem rótulo o primeiro parâmetro é só o telefone', () => {
  const p = connectionDownTemplateParams({ label: null, phone: '+5531999', downSince: new Date(), token: 't' });
  assert.equal(p.bodyParams[0], '+5531999');
});

test('parâmetro de corpo não leva quebra de linha, tab nem espaço repetido (Meta recusa)', () => {
  const p = connectionDownTemplateParams({
    label: 'Linha 1\nLinha\t2     fim',
    phone: '+5531999',
    downSince: new Date(),
    token: 't',
  });
  assert.doesNotMatch(p.bodyParams[0], /[\n\t]| {2,}/);
});
