import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateSafe, stripLoneSurrogates, hasLoneSurrogate } from '../../src/whatsapp/text-safety.js';
import { buildJudgmentPrompt } from '../../src/whatsapp/ai-judgment-prompt.js';
import type { JudgmentContext } from '../../src/whatsapp/ai-judgment-context.js';

/** Contexto mínimo (molde de tests/whatsapp/ai-judgment-prompt.test.ts). */
function promptCtx(): JudgmentContext {
  return {
    numberId: 1, identifier: 'c', workspaceId: 'ws', watermark: null,
    lastMessageAt: '2026-08-31T10:00:00.000Z',
    messages: [{ direction: 'inbound', text: '[áudio — transcrição indisponível]', createdAt: '2026-08-31T10:00:00.000Z' }],
    triage: { isLead: null, leadSource: null, notes: null },
    openOpp: null, lastClosedOpp: null,
    settings: { newOppAfterDays: 30, aiLeadGuidance: null, aiQualifiedGuidance: null },
    lossReasons: [], notLeadReasons: [], tags: [],
    sticky: { isLead: false, isQualified: false, status: false, lossReason: false, tagsRemovedByHuman: [] },
  };
}

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

// ── regra do marcador de áudio no prompt base ───────────────────────────────

test('prompt base ensina que marcador de áudio é informação AUSENTE, não desqualificação', () => {
  // Em 31/08/2026 o motor devolveu qualify:false com o racional "não forneceu
  // informações suficientes" numa conversa em que TODOS os áudios apareciam como
  // "[áudio — transcrição indisponível]". A falta era nossa, não do cliente.
  const { system } = buildJudgmentPrompt(promptCtx(), '2026-08-31T12:00:00.000Z');
  assert.match(system, /transcrição\s+indisponível/);
  assert.match(system, /INFORMAÇÃO AUSENTE/);
  assert.match(system, /NUNCA use esse marcador/);
});
