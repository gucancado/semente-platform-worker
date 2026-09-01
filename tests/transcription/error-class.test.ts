import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTranscriptionError, planTranscriptionRetry } from '../../src/transcription/error-class.js';

// ── classifyTranscriptionError ──────────────────────────────────────────────
// SISTÊMICO = a culpa é do ambiente (conta sem crédito, chave revogada, provedor
// fora do ar, rede). Reprocessar o MESMO áudio depois funciona. ITEM = a culpa é
// deste áudio; reprocessar dá o mesmo erro pra sempre.

test('429 sem crédito é sistêmico — foi o apagão de 24-31/08/2026', () => {
  assert.equal(
    classifyTranscriptionError('429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.'),
    'systemic',
  );
});

test('429 de rate limit é sistêmico', () => {
  assert.equal(classifyTranscriptionError('429 Rate limit reached for gpt-4o-mini-transcribe'), 'systemic');
});

test('401/403 (chave revogada ou sem permissão) é sistêmico', () => {
  assert.equal(classifyTranscriptionError('401 Incorrect API key provided'), 'systemic');
  assert.equal(classifyTranscriptionError('403 Forbidden'), 'systemic');
});

test('5xx do provedor é sistêmico', () => {
  assert.equal(classifyTranscriptionError('500 The server had an error processing your request'), 'systemic');
  assert.equal(classifyTranscriptionError('503 Service Unavailable'), 'systemic');
});

test('falha de rede é sistêmica', () => {
  assert.equal(classifyTranscriptionError('fetch failed'), 'systemic');
  assert.equal(classifyTranscriptionError('ECONNRESET'), 'systemic');
  assert.equal(classifyTranscriptionError('connect ETIMEDOUT 1.2.3.4:443'), 'systemic');
});

test('áudio corrompido é do ITEM — retentar não muda nada', () => {
  assert.equal(classifyTranscriptionError('400 Audio file might be corrupted or unsupported'), 'item');
});

test('mídia ainda não descriptografada é do ITEM (retry curto normal)', () => {
  assert.equal(classifyTranscriptionError('evolution base64 vazio (mídia não pronta)'), 'item');
});

test('erro DESCONHECIDO cai em item — preserva o comportamento atual', () => {
  // Falhar aberto (tratar desconhecido como sistêmico) deixaria job com defeito
  // real girando na fila pra sempre. Só o que reconhecemos ganha o tratamento novo.
  assert.equal(classifyTranscriptionError('algo que nunca vimos'), 'item');
});

// ── planTranscriptionRetry ──────────────────────────────────────────────────

const base = { attempts: 4, maxAttempts: 4, ageH: 1, systemicMaxAgeH: 72 };

test('erro de ITEM com tentativas esgotadas: falha terminal (comportamento atual)', () => {
  const p = planTranscriptionRetry({ ...base, error: '400 Audio file might be corrupted or unsupported' });
  assert.equal(p.action, 'fail');
  assert.equal(p.systemic, false);
});

test('erro de ITEM com tentativas sobrando: retry com backoff curto e CONSOME tentativa', () => {
  const p = planTranscriptionRetry({ ...base, attempts: 2, error: 'evolution base64 vazio (mídia não pronta)' });
  assert.equal(p.action, 'retry');
  assert.equal(p.consumesAttempt, true);
  assert.equal(p.backoffSec, 60); // attempts(2) * 30
});

test('erro SISTÊMICO não consome tentativa mesmo com attempts no limite — o núcleo da auto-recuperação', () => {
  const p = planTranscriptionRetry({ ...base, error: '429 You have no credits remaining.' });
  assert.equal(p.action, 'retry');
  assert.equal(p.consumesAttempt, false);
  assert.equal(p.systemic, true);
});

test('erro SISTÊMICO usa backoff longo — não martela um provedor que já disse não', () => {
  const p = planTranscriptionRetry({ ...base, error: '429 You have no credits remaining.' });
  assert.equal(p.backoffSec, 900); // 15 min
});

test('sistêmico que passa do teto de idade vira falha terminal — a fila não é infinita', () => {
  const p = planTranscriptionRetry({ ...base, ageH: 73, error: '429 You have no credits remaining.' });
  assert.equal(p.action, 'fail');
  assert.equal(p.systemic, true);
});

test('teto de idade NÃO se aplica a erro de item (quem manda ali é attempts)', () => {
  const p = planTranscriptionRetry({ ...base, attempts: 1, ageH: 500, error: 'evolution base64 vazio (mídia não pronta)' });
  assert.equal(p.action, 'retry');
});
