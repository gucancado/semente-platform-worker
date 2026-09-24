import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opsCopyFor, sameWhatsappNumber } from '../../src/whatsapp/down-notify-ops-copy.js';
import { opsAlertTemplateParams } from '../../src/webhook-cloud/templates.js';

const base = {
  name: 'Pousada Recanto de Moriá',
  phone: '+553195950748',
  downSince: new Date('2026-09-09T21:10:00.000Z'),
  notifyNumber: 1,
  maxNotifies: 6,
};

test('a cópia nomeia quem caiu, quando caiu e em que aviso do episódio está', () => {
  const { titulo, detalhe } = opsCopyFor(base);
  assert.match(titulo, /Pousada Recanto de Moriá/);
  assert.match(titulo, /\+553195950748/);
  assert.match(detalhe, /09\/09 às 18:10/); // sempre BRT: o container roda em UTC
  assert.match(detalhe, /Aviso 1 de 6/);
});

test('sem nome de workspace, o telefone sozinho identifica', () => {
  const { titulo } = opsCopyFor({ ...base, name: null });
  assert.equal(titulo, 'WhatsApp de +553195950748 caiu');
});

test('a cópia NÃO leva o link de reconexão: ele é travado no telefone que caiu', () => {
  const { titulo, detalhe } = opsCopyFor(base);
  for (const v of [titulo, detalhe]) {
    assert.doesNotMatch(v, /reconectar-whatsapp/, 'link no aviso do operador vira logout da instância do cliente');
    assert.doesNotMatch(v, /https?:\/\//);
  }
});

test('a cópia não repete a instrução de escanear QR, que é falsa para quem só acompanha', () => {
  const { detalhe } = opsCopyFor(base);
  assert.doesNotMatch(detalhe, /escanei/i);
  assert.doesNotMatch(detalhe, /\bQR\b/);
});

// A RAZÃO DA FORMA: os dois viram PARÂMETRO de template da Meta, que recusa a
// mensagem inteira com quebra de linha, tab, espaço repetido ou parâmetro vazio.
test('título e detalhe são de uma linha só, mesmo com nome sujo', () => {
  const { titulo, detalhe } = opsCopyFor({ ...base, name: 'Nome\ncom\tquebra   e   espaços' });
  for (const v of [titulo, detalhe]) {
    assert.doesNotMatch(v, /[\n\r\t]/);
    assert.doesNotMatch(v, / {2,}/);
    assert.ok(v.trim().length > 0);
  }
});

test('os parâmetros passam pelo sanitizador do template sem serem alterados nem truncados', () => {
  const copy = opsCopyFor(base);
  const { bodyParams } = opsAlertTemplateParams(copy);
  assert.deepEqual(bodyParams, [copy.titulo, copy.detalhe]);
});

// ── sameWhatsappNumber ───────────────────────────────────────────────────────

test('mesmo número com e sem "+" é o mesmo: as duas fontes gravam em formatos diferentes', () => {
  assert.equal(sameWhatsappNumber('+553196039118', '553196039118'), true);
  assert.equal(sameWhatsappNumber('+55 (31) 96039-118', '553196039118'), true);
});

test('números diferentes não são suprimidos', () => {
  assert.equal(sameWhatsappNumber('+553195950748', '553196039118'), false);
});

test('nono dígito: o MESMO celular gravado com 13 e com 12 dígitos', () => {
  assert.equal(sameWhatsappNumber('+5531996039118', '553196039118'), true);
  assert.equal(sameWhatsappNumber('553196039118', '+5531996039118'), true);
});

test('a tolerância do nono dígito é narrow — não funde números de fato distintos', () => {
  // Mesmo tamanho, dígito diferente no meio: nada a tolerar.
  assert.equal(sameWhatsappNumber('+5531996039118', '+5531996039119'), false);
  // 13 dígitos sem '9' no início do assinante: não é o caso do nono dígito.
  assert.equal(sameWhatsappNumber('+5531896039118', '553196039118'), false);
  // Fora do Brasil, tamanho diferente é número diferente.
  assert.equal(sameWhatsappNumber('+1415996039118', '141596039118'), false);
});

test('valor ausente nunca é "igual" — suprimir a cópia por engano é o erro caro', () => {
  assert.equal(sameWhatsappNumber(undefined, '553196039118'), false);
  assert.equal(sameWhatsappNumber('553196039118', null), false);
  assert.equal(sameWhatsappNumber('', ''), false);
  assert.equal(sameWhatsappNumber('sem dígitos', 'sem dígitos'), false);
});
