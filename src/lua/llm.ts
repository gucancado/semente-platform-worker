// Cliente LLM injetavel da Lua (spec Lua v1 §5.4).
//
// Interface injetavel: extracao (Task 11), judge de supersede e narradora
// (tasks futuras) recebem um LlmClient por parametro, de modo que os testes
// usam fakes roteirizados e nunca tocam a rede (decisao da spec §15.3). O
// cliente real (Anthropic) usa structured output via tool_choice forcado e
// herda o retry-once-no-parse (spec §7): "Erros de parsing do structured
// output: 1 re-tentativa imediata com o erro no prompt; persistindo, falha".
//
// O parse + retry vive AQUI (runWithParseRetry), fatorado para ser testavel
// sem rede: extract/judge herdam o comportamento sem reimplementar. Modelo
// default 'claude-sonnet-4-6' (spec §5.4 — julgamento medio).
//
// Prompt caching: o `system` (estatico, ex.: ~1500 tok da extracao) e os `tools`
// sao enviados com um cache breakpoint `cache_control: ephemeral` no bloco system.
// A ordem de cache da API e tools -> system -> messages, entao um breakpoint no
// system cacheia o prefixo inteiro (tools + system); o `user` (transcript) varia
// e fica fora do cache. Abaixo do minimo cacheavel (~1024 tok p/ Sonnet/Opus) a
// API simplesmente ignora o breakpoint (no-op sem erro) — seguro p/ judges curtos.

import Anthropic from '@anthropic-ai/sdk';

// ── Medição de custo (instrumentação do bootstrap / runs) ───────────────────
//
// O cliente real descarta `res.usage`; aqui acumulamos tokens + custo num meter
// de processo (o bootstrap é um processo só; workers concorrentes somam no mesmo
// total, que é o que queremos). resetLlmUsage() no início do run, readLlmUsage()
// no fim. Tarifas por 1M tokens (USD); fallback Sonnet p/ modelo desconhecido.

const PRICING_USD_PER_M: Record<
  string,
  { in: number; out: number; cacheRead: number; cacheWrite: number }
> = {
  'claude-sonnet-4-6': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

export interface LlmCallTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Custo USD de uma chamada, pela tarifa do modelo (fallback Sonnet 4.6). */
export function computeCallCostUsd(model: string, u: LlmCallTokens): number {
  const p = PRICING_USD_PER_M[model] ?? PRICING_USD_PER_M['claude-sonnet-4-6']!;
  return (u.input * p.in + u.output * p.out + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1_000_000;
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
 * Cria um LlmClient real sobre `@anthropic-ai/sdk`. Modelo default
 * 'claude-sonnet-4-6' (spec §5.4). Construir o cliente NAO faz chamada de rede.
 *
 * Structured output via tool forcado: declaramos uma unica ferramenta cujo
 * input_schema e o `schema` pedido e forcamos `tool_choice` nela; a saida vem
 * no `input` do bloco tool_use, ja como objeto. Validamos que o bloco existe;
 * o retry-once (runWithParseRetry) cobre saida ausente/malformada.
 *
 * Esta funcao NAO e exercida pelos testes (sem rede) — o encanamento e o retry
 * sao testados via runWithParseRetry com um `raw` fake.
 */
export function makeAnthropicClient(
  apiKey: string,
  opts?: { model?: string },
): LlmClient {
  const model = opts?.model ?? 'claude-sonnet-4-6';
  const client = new Anthropic({ apiKey });
  const TOOL_NAME = 'registrar_saida';

  return {
    model,
    async complete<T = unknown>(args: LlmCompletionArgs): Promise<T> {
      const maxTokens = args.maxTokens ?? 8192;

      // `raw` faz UMA chamada ao SDK e devolve o JSON cru do bloco tool_use.
      // O parse (JSON.parse) roda em runWithParseRetry, que cobre o retry-once.
      const raw = async (user: string): Promise<string> => {
        const res = await client.messages.create({
          model,
          max_tokens: maxTokens,
          // Forma array com cache breakpoint: cacheia o prefixo tools + system
          // (a API processa tools -> system -> messages). O user fica fora.
          system: [
            { type: 'text', text: args.system, cache_control: { type: 'ephemeral' } },
          ] satisfies Anthropic.TextBlockParam[],
          tools: [
            {
              name: TOOL_NAME,
              description:
                'Registra a saida estruturada no formato exigido. Chame esta ferramenta exatamente uma vez.',
              input_schema: args.schema as Anthropic.Tool.InputSchema,
            },
          ],
          tool_choice: { type: 'tool', name: TOOL_NAME },
          messages: [{ role: 'user', content: user }],
        });
        // Contabiliza custo (input/output/cache) no meter de processo.
        recordLlmUsage(model, {
          input: res.usage.input_tokens,
          output: res.usage.output_tokens,
          cacheRead: (res.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
          cacheWrite: (res.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0,
        });
        const block = res.content.find(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL_NAME,
        );
        if (!block) {
          throw new Error('resposta sem bloco tool_use esperado');
        }
        // O SDK ja entrega `input` como objeto; reserializamos para passar pelo
        // mesmo caminho de parse (JSON.parse) que valida a forma e dispara retry.
        return JSON.stringify(block.input);
      };

      return runWithParseRetry(raw, (text) => JSON.parse(text) as T, args.user);
    },
  };
}
