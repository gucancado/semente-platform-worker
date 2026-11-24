/**
 * src/weekly-context/service.ts — gera (e regrava) o resumo semanal de UM workspace.
 *
 * Sem material (nenhuma mensagem de grupo nem reunião na janela) grava 'empty'
 * sem chamar o LLM. Falha da chamada grava 'failed' (o poller tenta de novo depois
 * de 1h; o painel continua mostrando o último resumo bom). O custo vai para
 * llm_metrics com agent 'weekly-context' — fora da lista do custo de IA do
 * WhatsApp (src/whatsapp/ai-cost.ts), que é outro produto.
 */
import type { Pool } from 'pg';
import type { TextLlm } from '../llm/types.js';
import { llmCost } from '../llm/pricing.js';
import { insertLlmMetric } from '../db.js';
import { buildWeeklyContextPrompt, cleanSummary, saoPauloParts } from './core.js';
import { loadContextInputs, upsertWeeklyContext } from './db.js';

export type WeeklyContextDeps = {
  pool: Pool;
  llm: TextLlm;
  effort?: 'low' | 'medium' | 'high';
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
  now?: () => Date;
};

export type WeeklyContextResult = { status: 'ok' | 'empty' | 'failed'; summary: string | null; costUsd: number | null };

/** Teto de saída: inclui o raciocínio interno (cobrado), o texto em si é ~100 tokens. */
const MAX_TOKENS = 4000;
const TIMEOUT_MS = 90_000;

export async function generateWeeklyContext(
  deps: WeeklyContextDeps,
  workspaceId: string,
  weekStart: string,
  generatedBy: string | null,
): Promise<WeeklyContextResult> {
  const now = (deps.now ?? (() => new Date()))();
  const input = await loadContextInputs(deps.pool, workspaceId);
  const sources = { messages: input.messages.length, meetings: input.meetings.length };
  const base = { workspaceId, weekStart, sources, generatedBy };

  if (sources.messages === 0 && sources.meetings === 0) {
    await upsertWeeklyContext(deps.pool, {
      ...base, status: 'empty', summary: null, provider: null, model: null,
      tokensIn: null, tokensOut: null, costUsd: null, error: null,
    });
    return { status: 'empty', summary: null, costUsd: null };
  }

  const [y, m, d] = saoPauloParts(now).day.split('-');
  const { system, user } = buildWeeklyContextPrompt({ ...input, today: `${d}/${m}/${y}` });
  const startedAt = Date.now();
  let summary: string | null = null;
  let error: string | null = null;
  let usage: { input: number; output: number; cachedInput: number; cacheWrite: number } | null = null;
  try {
    const r = await deps.llm.complete({
      system, messages: [{ role: 'user', content: user }],
      maxTokens: MAX_TOKENS, effort: deps.effort ?? 'medium', timeoutMs: TIMEOUT_MS,
    });
    usage = r.usage;
    const text = cleanSummary(r.text);
    if (r.finishReason !== 'stop') error = `finish_reason=${r.finishReason ?? 'null'}`;
    else if (!text) error = 'texto vazio';
    else summary = text;
  } catch (err) {
    error = (err as Error).message ?? String(err);
  }

  const costUsd = usage ? llmCost(deps.llm.model, usage) : null;
  // Telemetria best-effort, inclusive da tentativa que falhou.
  insertLlmMetric({
    agent: 'weekly-context', task: 'weekly_context', provider: deps.llm.provider, model: deps.llm.model,
    tokens_in: usage?.input ?? null, tokens_out: usage?.output ?? null,
    cache_read_tokens: usage?.cachedInput ?? null, cache_write_tokens: usage?.cacheWrite ?? null,
    cost_usd: costUsd, latency_ms: Date.now() - startedAt, error, workspace_id: workspaceId,
  }).catch(() => {});

  const status = summary ? 'ok' : 'failed';
  await upsertWeeklyContext(deps.pool, {
    ...base, status, summary, provider: deps.llm.provider, model: deps.llm.model,
    tokensIn: usage?.input ?? null, tokensOut: usage?.output ?? null, costUsd, error,
  });
  if (error) deps.log?.warn({ workspaceId, weekStart, error }, 'weekly-context: geração falhou');
  else deps.log?.info({ workspaceId, weekStart, sources, costUsd }, 'weekly-context: resumo gerado');
  return { status, summary, costUsd };
}
