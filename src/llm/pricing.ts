/**
 * src/llm/pricing.ts
 *
 * Tabela ÚNICA de preço de LLM de texto, US$ por 1M tokens. Chave = id do
 * modelo (os ids não colidem entre provedores). É o que grava
 * `llm_metrics.cost_usd` de todas as tarefas de texto.
 *
 * Fonte dos preços Anthropic: skill claude-api (tabela "Current Models",
 * cache de 2026-11-03) — NUNCA da memória do modelo. Cache: leitura = 0,1× a
 * entrada (0,05× no Sonnet 5.5 e no Opus 5.5), escrita de 5 min = 1,25×.
 * OpenAI: os valores que já estavam nos providers (gpt-5.4-mini corrigido pela
 * revisão do Codex).
 *
 * Modelo fora da tabela cai no FALLBACK CARO: errar aqui é silencioso
 * (`cost_usd` menor que a fatura), então superestimar é o erro certo.
 */
import type { LlmUsage } from './types.js';

export type ModelRate = {
  input: number;
  output: number;
  /** Leitura de cache; ausente = a parte cacheada é cobrada como entrada cheia. */
  cachedInput?: number;
  /** Escrita de cache (TTL 5 min). Ausente = cobrada como entrada cheia. */
  cacheWrite?: number;
  /** Faixa longa: acima de `overTokens` de entrada a chamada inteira usa estes preços. */
  longContext?: { overTokens: number; input: number; output: number; cachedInput?: number; cacheWrite?: number };
};

export const MODEL_RATES: Record<string, ModelRate> = {
  // ── Anthropic ──
  'claude-haiku-5-5': {
    input: 0.1, output: 0.5, cachedInput: 0.01, cacheWrite: 0.125,
    longContext: { overTokens: 100_000, input: 0.5, output: 2.5, cachedInput: 0.05, cacheWrite: 0.625 },
  },
  'claude-sonnet-5-5': { input: 2, output: 10, cachedInput: 0.1, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cachedInput: 0.2, cacheWrite: 5 },
  'claude-sonnet-5': { input: 2, output: 10, cachedInput: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cachedInput: 0.1, cacheWrite: 1.25 },
  'claude-opus-4-8': { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 },
  // ── OpenAI ──
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cachedInput: 0.075 },
};

/** O mais caro dos modelos que este worker usa de fato (Opus 5.5). */
export const FALLBACK_RATE: ModelRate = { input: 4, output: 20 };

function num(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Custo em US$ de UMA chamada. `usage.input` é o TOTAL de entrada (ver LlmUsage). */
export function llmCost(model: string, usage: Partial<LlmUsage>, fallback: ModelRate = FALLBACK_RATE): number {
  const base = MODEL_RATES[model] ?? fallback;
  const input = num(usage.input);
  const rate = base.longContext && input > base.longContext.overTokens ? base.longContext : base;
  const output = num(usage.output);
  // Sem preço de cache conhecido, a parte cacheada fica DENTRO de `fresh` e é
  // cobrada cheia (superestima). Nunca subtrair sem o preço correspondente.
  const cached = rate.cachedInput != null ? Math.min(num(usage.cachedInput), input) : 0;
  const written = rate.cacheWrite != null ? Math.min(num(usage.cacheWrite), input - cached) : 0;
  const fresh = input - cached - written;
  return (
    (fresh * rate.input +
      cached * (rate.cachedInput ?? 0) +
      written * (rate.cacheWrite ?? 0) +
      output * rate.output) /
    1_000_000
  );
}
