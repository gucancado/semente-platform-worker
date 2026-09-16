import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDigits, attachLastMessage } from '../../src/whatsapp/group-activity.js';

test('canonicalDigits remove domínio, device e não-dígitos', () => {
  assert.equal(canonicalDigits('+553196039118'), '553196039118');
  assert.equal(canonicalDigits('553196039118@s.whatsapp.net'), '553196039118');
  // Nunca observado em produção (0 de ~40 mil autores), mas o pipeline não
  // garante a ausência: canonicalJid não remove o device.
  assert.equal(canonicalDigits('553196039118:12@s.whatsapp.net'), '553196039118');
  assert.equal(canonicalDigits(null), '');
});

test('casa por telefone', () => {
  const [p] = attachLastMessage(
    [{ phone: '+553196039118', lid: null }],
    new Map([['553196039118', '2026-09-10T12:00:00.000Z']]),
  );
  assert.equal(p.lastMessageAt, '2026-09-10T12:00:00.000Z');
});

test('casa por LID quando o autor foi gravado como +<lid>', () => {
  const [p] = attachLastMessage(
    [{ phone: '+553196039118', lid: '93557490733105' }],
    new Map([['93557490733105', '2026-09-11T08:00:00.000Z']]),
  );
  assert.equal(p.lastMessageAt, '2026-09-11T08:00:00.000Z');
});

test('com as duas chaves presentes, vence a mensagem MAIS RECENTE', () => {
  const [p] = attachLastMessage(
    [{ phone: '+553196039118', lid: '93557490733105' }],
    new Map([
      ['553196039118', '2026-09-01T10:00:00.000Z'],
      ['93557490733105', '2026-09-12T10:00:00.000Z'],
    ]),
  );
  assert.equal(p.lastMessageAt, '2026-09-12T10:00:00.000Z');
});

test('autor desconhecido → sem registro', () => {
  const [p] = attachLastMessage([{ phone: '+5531000', lid: null }], new Map());
  assert.equal(p.lastMessageAt, null);
});

test('chave ambígua entre dois participantes → AMBOS sem registro', () => {
  // Atribuir silenciosamente a atividade de um a outro (last-write-wins)
  // dependeria da ordem do roster e ninguém perceberia olhando a tela.
  const out = attachLastMessage(
    [{ phone: '+553196039118', lid: null }, { phone: '553196039118', lid: null }],
    new Map([['553196039118', '2026-09-10T12:00:00.000Z']]),
  );
  assert.deepEqual(out.map((p) => p.lastMessageAt), [null, null]);
});

test('não muta a entrada e preserva os campos originais', () => {
  const input = [{ phone: '+5531999', lid: null, pushName: 'Ana' }];
  const [p] = attachLastMessage(input, new Map());
  assert.equal(p.pushName, 'Ana');
  assert.equal((input[0] as any).lastMessageAt, undefined);
});
