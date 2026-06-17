import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCallCostUsd,
  resetLlmUsage,
  readLlmUsage,
  recordLlmUsage,
} from '../../src/lua/llm.js';

// Medição de custo do LLM da Lua (instrumentação do bootstrap). Puro, sem rede.

test('computeCallCostUsd: tarifa Sonnet 4.6 por 1M (in $3 / out $15 / cacheRead $0.30 / cacheWrite $3.75)', () => {
  const m = 'claude-sonnet-4-6';
  assert.equal(computeCallCostUsd(m, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), 3);
  assert.equal(computeCallCostUsd(m, { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }), 15);
  assert.ok(Math.abs(computeCallCostUsd(m, { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }) - 0.3) < 1e-9);
  assert.ok(Math.abs(computeCallCostUsd(m, { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }) - 3.75) < 1e-9);
});

test('computeCallCostUsd: modelo desconhecido cai no fallback Sonnet (não zera custo)', () => {
  assert.equal(computeCallCostUsd('modelo-novo-desconhecido', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), 3);
});

test('meter de usage: acumula chamadas/tokens/custo e reseta', () => {
  resetLlmUsage();
  recordLlmUsage('claude-sonnet-4-6', { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 });
  recordLlmUsage('claude-sonnet-4-6', { input: 500, output: 100, cacheRead: 50, cacheWrite: 0 });
  const u = readLlmUsage();
  assert.equal(u.calls, 2);
  assert.equal(u.inputTokens, 1500);
  assert.equal(u.outputTokens, 300);
  assert.equal(u.cacheReadTokens, 50);
  assert.ok(u.costUsd > 0, 'custo acumulado > 0');

  resetLlmUsage();
  const z = readLlmUsage();
  assert.equal(z.calls, 0);
  assert.equal(z.inputTokens, 0);
  assert.equal(z.costUsd, 0);
});
