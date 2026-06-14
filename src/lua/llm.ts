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

import Anthropic from '@anthropic-ai/sdk';

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
          system: args.system,
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
