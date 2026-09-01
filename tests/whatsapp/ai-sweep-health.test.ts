import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessSweepHealth } from '../../src/whatsapp/ai-sweep-health.js';

test('run normal é ok', () => {
  assert.equal(assessSweepHealth({ processed: 200, applied: 150, errors: 0 }).level, 'ok');
});

test('run em que TODAS as conversas falharam é outage — foi o apagão de 24-31/08/2026', () => {
  const h = assessSweepHealth({ processed: 200, applied: 0, errors: 200 });
  assert.equal(h.level, 'outage');
  assert.match(h.reason, /todas/i);
});

test('maioria falhando é degraded', () => {
  assert.equal(assessSweepHealth({ processed: 200, applied: 40, errors: 160 }).level, 'degraded');
});

test('punhado de erros num run grande continua ok — 2 falhas de parse não são incidente', () => {
  assert.equal(assessSweepHealth({ processed: 82, applied: 74, errors: 2 }).level, 'ok');
});

test('run vazio é ok — nada pendente não é problema', () => {
  assert.equal(assessSweepHealth({ processed: 0, applied: 0, errors: 0 }).level, 'ok');
});

test('processed>0 sem erro e sem aplicação é ok — a IA pode decidir não agir', () => {
  // Distinção que importa: "nada a fazer" (applied=0, errors=0) é uma decisão
  // legítima do motor; "tudo falhou" (errors=processed) é infraestrutura quebrada.
  assert.equal(assessSweepHealth({ processed: 30, applied: 0, errors: 0 }).level, 'ok');
});
