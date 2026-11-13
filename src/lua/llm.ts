// Cliente LLM injetavel da Lua (spec Lua v1 §5.4).
//
// Interface injetavel: extracao, judge de supersede e narradora recebem um
// LlmClient por parametro, de modo que os testes usam fakes roteirizados e
// nunca tocam a rede (spec §15.3). O cliente real passa pela camada de
// provedor src/llm/ (LUA_PROVIDER: anthropic | openai) com structured output
// e herda o retry-once-no-parse (spec §7): "Erros de parsing do structured
// output: 1 re-tentativa imediata com o erro no prompt; persistindo, falha".
//
// O parse + retry vive AQUI (runWithParseRetry), testavel sem rede.
// Modelo default 'claude-sonnet-5-5' (config.ts).
//
// Prompt caching: o adapter Anthropic poe cache breakpoint no `system`; o
// `user` (transcript) varia e fica fora. Abaixo do minimo cacheavel a API
// ignora o breakpoint (no-op sem erro).

import { llmCost, MODEL_RATES } from '../llm/pricing.js';
import type { TextLlm } from '../llm/types.js';

// ── Medição de custo (instrumentação do bootstrap / runs) ───────────────────
//
// O cliente real descarta `res.usage`; aqui acumulamos tokens + custo num meter
// de processo (o bootstrap é um processo só; workers concorrentes somam no mesmo
// total, que é o que queremos). resetLlmUsage() no início do run, readLlmUsage()
// no fim. Tarifas por 1M tokens (USD); fallback Sonnet p/ modelo desconhecido.

export interface LlmCallTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Custo USD de uma chamada (tabela única src/llm/pricing.ts; fallback Sonnet 4.6).
 *  `input` aqui é só o fresco — a camada central espera o total. */
export function computeCallCostUsd(model: string, u: LlmCallTokens): number {
  return llmCost(
    model,
    { input: u.input + u.cacheRead + u.cacheWrite, output: u.output, cachedInput: u.cacheRead, cacheWrite: u.cacheWrite },
    MODEL_RATES['claude-sonnet-4-6'],
  );
}

export interface LlmUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

function zeroUsage(): LlmUsageTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

let usageMeter: LlmUsageTotals = zeroUsage();

export function resetLlmUsage(): void {
  usageMeter = zeroUsage();
}

export function readLlmUsage(): LlmUsageTotals {
  return { ...usageMeter };
}

export function recordLlmUsage(model: string, u: LlmCallTokens): void {
  usageMeter.calls += 1;
  usageMeter.inputTokens += u.input;
  usageMeter.outputTokens += u.output;
  usageMeter.cacheReadTokens += u.cacheRead;
  usageMeter.cacheWriteTokens += u.cacheWrite;
  usageMeter.costUsd += computeCallCostUsd(model, u);
}

/** Argumentos de uma chamada de completude estruturada. */
export interface LlmCompletionArgs {
  /** Prompt de sistema (PT-BR): contrato + instrucoes. */
  system: string;
  /** Mensagem do usuario (PT-BR): o conteudo a processar. */
  user: string;
  /** JSON Schema do objeto estruturado esperado na saida. */
  schema: object;
  /** Teto de tokens de saida (default 8192). */
  maxTokens?: number;
}

/** Cliente LLM injetavel. Uma implementacao real (Anthropic) e fakes nos testes. */
export interface LlmClient {
  /** Identificador do modelo, ex.: 'claude-sonnet-4-6'. */
  model: string;
  /**
   * Devolve o objeto estruturado ja parseado e validado contra `schema`. A
   * implementacao usa o mecanismo de structured output / tool do provedor. Em
   * falha de parse: UMA re-tentativa com o erro anexado ao prompt; persistindo,
   * lanca.
   */
  complete<T = unknown>(args: LlmCompletionArgs): Promise<T>;
}

/**
 * Executa uma chamada crua (`raw`) e parseia (`parse`) com retry-once.
 *
 * Contrato (spec §7): se `parse` lancar na 1a tentativa, reenvia UMA vez com o
 * prompt original + o erro de parse anexado; se falhar de novo, propaga o erro.
 * Network-free por construcao — `raw` e injetado. E aqui que o cliente real e
 * os fakes de teste compartilham exatamente a mesma semantica de retry.
 */
export async function runWithParseRetry<T>(
  raw: (user: string) => Promise<string>,
  parse: (text: string) => T,
  user: string,
): Promise<T> {
  const first = await raw(user);
  try {
    return parse(first);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Reenvio: prompt original + nota do erro de parse, para o modelo corrigir.
    const retryUser =
      `${user}\n\n[A resposta anterior nao pode ser parseada como JSON valido. ` +
      `Erro: ${reason}. Responda novamente com APENAS o JSON estruturado correto.]`;
    const second = await raw(retryUser);
    return parse(second);
  }
}

/**
 * Cria um LlmClient sobre o TextLlm da camada src/llm/ (provedor escolhido por
 * LUA_PROVIDER). Construir NAO faz chamada de rede.
 *
 * Structured output: na Anthropic via `output_config.format` (o tool forcado
 * antigo da 400 no Sonnet 5.5 / Opus 5.5); na OpenAI via json_object. O
 * retry-once (runWithParseRetry) cobre saida ausente/malformada.
 */
export function makeTextLlmClient(llm: TextLlm): LlmClient {
  return {
    model: llm.model,
    async complete<T = unknown>(args: LlmCompletionArgs): Promise<T> {
      const raw = async (user: string): Promise<string> => {
        const r = await llm.complete({
          system: args.system,
          messages: [{ role: 'user', content: user }],
          json: { schema: args.schema as Record<string, unknown> },
          maxTokens: args.maxTokens ?? 8192,
        });
        recordLlmUsage(llm.model, {
          input: r.usage.input - r.usage.cachedInput - r.usage.cacheWrite,
          output: r.usage.output,
          cacheRead: r.usage.cachedInput,
          cacheWrite: r.usage.cacheWrite,
        });
        if (r.finishReason === 'refusal') throw new Error('resposta recusada pelo modelo (refusal)');
        return r.text;
      };
      return runWithParseRetry(raw, (text) => JSON.parse(text) as T, args.user);
    },
  };
}
