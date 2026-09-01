import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateSafe, stripLoneSurrogates, hasLoneSurrogate } from '../../src/whatsapp/text-safety.js';

const EMOJI = '📅'; // U+1F4C5 = par surrogate 📅

test('truncateSafe não deixa meio emoji no corte — a causa do 400 da OpenAI', () => {
  // "abc📅" tem 5 unidades UTF-16; cortar em 4 partiria o par ao meio.
  const s = 'abc' + EMOJI;
  const out = truncateSafe(s, 4);
  assert.equal(hasLoneSurrogate(out), false);
  assert.equal(out, 'abc', 'o emoji inteiro sai, nunca metade dele');
});

test('truncateSafe mantém o emoji quando ele cabe inteiro', () => {
  const s = 'abc' + EMOJI;
  assert.equal(truncateSafe(s, 5), s);
});

test('truncateSafe não mexe em texto menor que o limite', () => {
  assert.equal(truncateSafe('oi', 100), 'oi');
});

test('truncateSafe corta texto comum normalmente', () => {
  assert.equal(truncateSafe('abcdef', 3), 'abc');
});

test('hasLoneSurrogate detecta alto órfão e baixo órfão', () => {
  assert.equal(hasLoneSurrogate('x\uD83Dy'), true);
  assert.equal(hasLoneSurrogate('x\uDCC5y'), true);
  assert.equal(hasLoneSurrogate('x' + EMOJI + 'y'), false);
  assert.equal(hasLoneSurrogate('texto normal'), false);
});

test('stripLoneSurrogates remove só o órfão e preserva o resto', () => {
  const out = stripLoneSurrogates('ok \uD83D fim ' + EMOJI);
  assert.equal(hasLoneSurrogate(out), false);
  assert.equal(out, 'ok  fim ' + EMOJI);
});

test('stripLoneSurrogates é no-op em texto são — não pode corromper o prompt normal', () => {
  const s = 'Cliente pediu orçamento ' + EMOJI + ' para amanhã';
  assert.equal(stripLoneSurrogates(s), s);
});
