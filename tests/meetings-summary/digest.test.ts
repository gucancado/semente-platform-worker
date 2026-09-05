/**
 * Testes PUROS do digest de reunião — sem banco de propósito: as suítes
 * `*.db.test.ts` deste repo exigem Postgres local, que não existe nesta máquina.
 * Por isso a lógica que pode corromper a fila foi extraída para funções puras
 * (`nextJobOutcome`, `classifySummaryError`, `parseDigest`), e é o que se testa
 * aqui.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APIError, APIConnectionError } from 'openai';

import {
  flattenTurns, parseDigest, buildSummaryPrompt,
  MAX_POINTS, MAX_SUMMARY_CHARS,
} from '../../src/meetings-summary/prompt.js';
import { classifySummaryError, SYSTEMIC_MAX_AGE_H } from '../../src/meetings-summary/error-class.js';
import { summaryCost, isReasoningModel } from '../../src/meetings-summary/provider.js';
import { nextJobOutcome } from '../../src/meetings-summary/retry-policy.js';

const turns = (n: number, text = 'fala razoavelmente longa para contar') =>
  Array.from({ length: n }, (_, i) => ({ speaker: `P${i % 3}`, text: `${text} ${i}` }));

// ── flattenTurns ────────────────────────────────────────────────────────────
test('flattenTurns não corta abaixo do teto', () => {
  const out = flattenTurns(turns(5), 10_000);
  assert.ok(!out.includes('[...trecho do meio omitido...]'));
  assert.ok(out.includes('P0: fala'));
});

test('flattenTurns corta pelo MEIO e preserva começo e fim', () => {
  const t = [
    { speaker: 'A', text: 'ABERTURA-MARCA' },
    ...turns(2000),
    { speaker: 'Z', text: 'FECHAMENTO-MARCA' },
  ];
  const out = flattenTurns(t, 2_000);
  assert.ok(out.includes('[...trecho do meio omitido...]'), 'marca o corte');
  assert.ok(out.includes('ABERTURA-MARCA'), 'preserva a pauta da abertura');
  assert.ok(out.includes('FECHAMENTO-MARCA'), 'preserva o encaminhamento do fim');
});

test('buildSummaryPrompt descarta o falante genérico "Speaker" do elenco', () => {
  const { user } = buildSummaryPrompt({
    title: 'T', durationSeconds: 600,
    participants: [{ name: 'Lucas' }, { name: 'Speaker' }], turns: turns(2),
  });
  assert.ok(user.includes('Participantes: Lucas'));
  assert.ok(!user.includes('Speaker'));
  assert.ok(user.includes('‹') && user.includes('›'), 'transcrição cercada');
});

// ── parseDigest ─────────────────────────────────────────────────────────────
test('parseDigest: JSON inválido é parse_error (retentável), não vazio', () => {
  assert.equal(parseDigest('não é json').outcome, 'parse_error');
  assert.equal(parseDigest('{"resumo": "cortado no me').outcome, 'parse_error');
  assert.equal(parseDigest('[]').outcome, 'parse_error');
});

test('parseDigest: objeto sem NENHUM dos campos é parse_error, não vazio', () => {
  // Este é o caso que motivou o outcome: `{}` de uma resposta cortada encerraria
  // o job como "reunião sem conteúdo" e o digest nunca seria gerado.
  assert.equal(parseDigest('{}').outcome, 'parse_error');
  assert.equal(parseDigest('{"outra":1}').outcome, 'parse_error');
});

test('parseDigest: campos presentes e vazios são "empty" (encerra)', () => {
  const r = parseDigest('{"resumo": "", "pontos": []}');
  assert.equal(r.outcome, 'empty');
  assert.equal(r.digest.summary, null);
  assert.deepEqual(r.digest.points, []);
});

test('parseDigest: resumo ruim não derruba os pontos', () => {
  const r = parseDigest('{"resumo": "n/a", "pontos": ["Ponto suficientemente longo para valer"]}');
  assert.equal(r.outcome, 'ok');
  assert.equal(r.digest.summary, null, 'resumo curto vira null');
  assert.equal(r.digest.points.length, 1, 'e os pontos sobrevivem');
});

test('parseDigest: item não-string é descartado sem derrubar os demais', () => {
  const r = parseDigest('{"pontos": ["Ponto válido bem comprido aqui", 42, null, {"a":1}]}');
  assert.equal(r.digest.points.length, 1);
});

test('parseDigest: remove marcador e numeração que o modelo insiste em pôr', () => {
  const r = parseDigest('{"pontos": ["- Primeiro ponto bem comprido", "2) Segundo ponto bem comprido"]}');
  assert.deepEqual(r.digest.points, ['Primeiro ponto bem comprido', 'Segundo ponto bem comprido']);
});

test('parseDigest: dedup por forma normalizada', () => {
  const r = parseDigest('{"pontos": ["Rastreamento migrou para Singular", "rastreamento migrou para singular!"]}');
  assert.equal(r.digest.points.length, 1);
});

test('parseDigest: respeita o teto de pontos', () => {
  const many = Array.from({ length: 20 }, (_, i) => `Ponto número ${i} com tamanho suficiente`);
  const r = parseDigest(JSON.stringify({ pontos: many }));
  assert.equal(r.digest.points.length, MAX_POINTS);
});

test('parseDigest: resumo longo é cortado em fronteira de palavra', () => {
  const long = 'palavra '.repeat(60).trim();
  const r = parseDigest(JSON.stringify({ resumo: long }));
  assert.ok(r.digest.summary!.length <= MAX_SUMMARY_CHARS + 1, 'dentro do teto');
  assert.ok(r.digest.summary!.endsWith('…'));
  assert.ok(!r.digest.summary!.includes('  '));
});

// ── classifySummaryError ────────────────────────────────────────────────────
function apiError(status: number, message: string): APIError {
  const e = Object.create(APIError.prototype) as APIError;
  Object.assign(e, { status, message, name: 'APIError' });
  return e;
}

test('classifySummaryError: ambiente vs item por STATUS', () => {
  for (const s of [429, 401, 403, 408, 409, 500, 502, 503]) {
    assert.equal(classifySummaryError(apiError(s, 'x')), 'systemic', `status ${s}`);
  }
  for (const s of [400, 404, 422]) {
    assert.equal(classifySummaryError(apiError(s, 'x')), 'item', `status ${s}`);
  }
});

test('classifySummaryError: o caso que motivou o módulo — "500000 tokens" num 400 é ITEM', () => {
  // O classificador da transcrição casa a SUBSTRING '500' na mensagem e chamaria
  // isto de falha sistêmica, deixando o job girar por 72h em vez de falhar já.
  const err = apiError(400, "This model's maximum context length is 500000 tokens, however you requested 620000");
  assert.equal(classifySummaryError(err), 'item');
});

test('classifySummaryError: erro de conexão é ambiente; desconhecido falha fechado', () => {
  assert.equal(classifySummaryError(new APIConnectionError({ message: 'socket hang up' })), 'systemic');
  assert.equal(classifySummaryError(new Error('vai saber')), 'item');
  assert.equal(classifySummaryError('string solta'), 'item');
});

// ── nextJobOutcome ──────────────────────────────────────────────────────────
const base = { attempts: 1, ageHours: 0, hasTurns: true };

test('nextJobOutcome: digest bom salva', () => {
  const parse = parseDigest('{"resumo":"Um resumo perfeitamente utilizavel","pontos":["Ponto bem comprido aqui"]}');
  assert.deepEqual(nextJobOutcome({ ...base, parse, finishReason: 'stop' }), { action: 'save' });
});

test('nextJobOutcome: parse_error RETENTA consumindo tentativa', () => {
  const r = nextJobOutcome({ ...base, parse: parseDigest('{}'), finishReason: 'stop' });
  assert.equal(r.action, 'retry');
  assert.equal((r as any).consumeAttempt, true);
});

test('nextJobOutcome: finish_reason=length retenta mesmo com JSON parseável', () => {
  const parse = parseDigest('{"resumo":"Um resumo perfeitamente utilizavel","pontos":[]}');
  const r = nextJobOutcome({ ...base, parse, finishReason: 'length' });
  assert.equal(r.action, 'retry');
  assert.match((r as any).reason, /truncada/);
});

test('nextJobOutcome: "empty" encerra o job, não retenta', () => {
  const r = nextJobOutcome({ ...base, parse: parseDigest('{"resumo":"","pontos":[]}'), finishReason: 'stop' });
  assert.equal(r.action, 'close_empty');
});

test('nextJobOutcome: falha de AMBIENTE não consome tentativa', () => {
  const r = nextJobOutcome({ ...base, attempts: 9, errorClass: 'systemic', errorMessage: '429' });
  assert.equal(r.action, 'retry');
  assert.equal((r as any).consumeAttempt, false, 'apagão não pode punir o job');
});

test('nextJobOutcome: falha de ambiente velha demais desiste (teto de IDADE)', () => {
  const r = nextJobOutcome({ ...base, ageHours: SYSTEMIC_MAX_AGE_H + 1, errorClass: 'systemic', errorMessage: '429' });
  assert.equal(r.action, 'fail');
});

test('nextJobOutcome: falha de ITEM desiste ao esgotar tentativas', () => {
  assert.equal(nextJobOutcome({ ...base, attempts: 1, errorClass: 'item', errorMessage: '400' }).action, 'retry');
  assert.equal(nextJobOutcome({ ...base, attempts: 4, errorClass: 'item', errorMessage: '400' }).action, 'fail');
});

test('nextJobOutcome: episódio sem turnos encerra sem chamar nada', () => {
  assert.equal(nextJobOutcome({ ...base, hasTurns: false }).action, 'close_empty');
});

// ── custo e modelo ──────────────────────────────────────────────────────────
test('summaryCost: modelo desconhecido usa o fallback caro, nunca 0', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 };
  assert.ok(summaryCost('modelo-que-nao-existe', usage) > 0);
  assert.equal(summaryCost('modelo-que-nao-existe', usage), 2.5);
});

test('summaryCost: token cacheado não é cobrado duas vezes', () => {
  const semCache = summaryCost('gpt-5.4-mini', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 });
  const comCache = summaryCost('gpt-5.4-mini', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 });
  assert.equal(semCache, 0.75);
  assert.equal(comCache, 0.075, 'entrada inteira cacheada custa a tarifa de cache');
  assert.ok(comCache < semCache);
});

test('summaryCost: reflete o preço medido do piloto', () => {
  // 13.669 in / 231 out no episódio 453 → ~US$0,0113. Se este número mudar sem
  // alguém ter mexido no preço de propósito, a tabela regrediu.
  const c = summaryCost('gpt-5.4-mini', { inputTokens: 13_669, outputTokens: 231, cachedInputTokens: 0 });
  assert.ok(c > 0.011 && c < 0.012, `esperado ~0,0113, veio ${c}`);
});

test('isReasoningModel', () => {
  assert.equal(isReasoningModel('gpt-5.4-mini'), true);
  assert.equal(isReasoningModel('gpt-5-mini'), true);
  assert.equal(isReasoningModel('o4-mini'), true);
  assert.equal(isReasoningModel('gpt-4o-mini'), false);
});
