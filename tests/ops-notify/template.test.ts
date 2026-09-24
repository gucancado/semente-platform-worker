/**
 * O corpo do template tem que casar BYTE A BYTE com o que foi submetido à Meta
 * (aviso_operacional_v1, id 1896879847947648). Divergir aqui não dá erro de
 * compilação nem de teste em lugar nenhum — dá recusa no envio, em produção.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPS_ALERT_TEMPLATE,
  OPS_ALERT_TEMPLATE_NAME,
  OPS_ALERT_PARAM_MAX,
  opsAlertTemplateParams,
  renderOpsAlertText,
} from '../../src/webhook-cloud/templates.js';

const body = OPS_ALERT_TEMPLATE.components.find((c) => c.type === 'BODY')!;
const vars = body.text.match(/\{\{\d+\}\}/g) ?? [];

// O texto submetido, escrito aqui de novo em vez de reusar a constante: é a
// asserção. Reusar a constante tornaria o teste verdadeiro por construção.
const SUBMETIDO =
  'Aviso do painel BeeAds: {{1}}\nDetalhe: {{2}}\nMensagem automática da BeeAds.';

test('corpo idêntico ao submetido à Meta', () => {
  assert.equal(body.text, SUBMETIDO);
});

test('nome, categoria e idioma do template submetido', () => {
  assert.equal(OPS_ALERT_TEMPLATE_NAME, 'aviso_operacional_v1');
  assert.equal(OPS_ALERT_TEMPLATE.name, OPS_ALERT_TEMPLATE_NAME);
  assert.equal(OPS_ALERT_TEMPLATE.category, 'UTILITY');
  assert.equal(OPS_ALERT_TEMPLATE.language, 'pt_BR');
});

test('duas variáveis, sem botão', () => {
  assert.deepEqual(vars, ['{{1}}', '{{2}}']);
  assert.deepEqual(OPS_ALERT_TEMPLATE.components.map((c) => c.type), ['BODY']);
});

test('corpo não começa nem termina com variável (regra de aprovação da Meta)', () => {
  assert.doesNotMatch(body.text, /^\s*\{\{/);
  assert.doesNotMatch(body.text, /\}\}\s*$/);
});

test('exemplo do corpo cobre exatamente as variáveis declaradas', () => {
  assert.equal(body.example.body_text[0].length, vars.length);
});

test('parâmetros casam em número e ordem com as variáveis (drift)', () => {
  const p = opsAlertTemplateParams({ titulo: '3 erros novos no painel', detalhe: 'TypeError · 12x' });
  assert.equal(p.bodyParams.length, vars.length);
  assert.deepEqual(p.bodyParams, ['3 erros novos no painel', 'TypeError · 12x']);
});

test('parâmetro não leva quebra de linha, tab nem espaço repetido (Meta recusa)', () => {
  const p = opsAlertTemplateParams({
    titulo: 'Linha 1\nLinha\t2     fim',
    detalhe: '• a\n\n• b\r\n• c',
  });
  for (const v of p.bodyParams) assert.doesNotMatch(v, /[\n\r\t]| {2,}/);
  assert.equal(p.bodyParams[1], '• a • b • c');
});

test('parâmetro vazio vira travessão — a Meta recusa string vazia', () => {
  const p = opsAlertTemplateParams({ titulo: 'x', detalhe: '   ' });
  assert.equal(p.bodyParams[1], '—');
  assert.equal(opsAlertTemplateParams({ titulo: 'x' }).bodyParams[1], '—');
  assert.equal(opsAlertTemplateParams({ titulo: 'x', detalhe: null }).bodyParams[1], '—');
});

test('parâmetro longo é truncado no teto, com reticência', () => {
  const p = opsAlertTemplateParams({ titulo: 'x', detalhe: 'a'.repeat(5000) });
  assert.equal(p.bodyParams[1].length, OPS_ALERT_PARAM_MAX);
  assert.ok(p.bodyParams[1].endsWith('…'));
});

test('texto de fallback é o MESMO corpo com as variáveis preenchidas', () => {
  const input = { titulo: 'ciclo abortou', detalhe: 'ECONNRESET' };
  assert.equal(
    renderOpsAlertText(input),
    'Aviso do painel BeeAds: ciclo abortou\nDetalhe: ECONNRESET\nMensagem automática da BeeAds.',
  );
  assert.doesNotMatch(renderOpsAlertText(input), /\{\{\d+\}\}/);
});
