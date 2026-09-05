/**
 * src/meetings-summary/error-class.ts
 *
 * Classificação da falha do digest e plano de retry. PURO (sem pg, sem env).
 *
 * MESMA SEMÂNTICA de src/transcription/error-class.ts — `systemic` não consome
 * tentativa, `item` consome — e pelo MESMO motivo histórico: quando a conta
 * OpenAI ficou sem crédito, o retry que tratava todo erro igual queimou as 4
 * tentativas de 1.002 áudios em minutos e os deixou `failed` PERMANENTE. Esta
 * chave é a mesma, então o digest tem exatamente a mesma exposição.
 *
 * O QUE MUDA em relação ao módulo da transcrição: lá a classificação é por
 * SUBSTRING na mensagem ('500', '401', 'rate limit'...). Aqui é pelo ERRO
 * ESTRUTURADO do SDK (`APIError.status`). Copiar o casamento de texto para cá
 * seria um bug esperando acontecer: mensagem de chat completion carrega contagem
 * de tokens, e um `400 ... maximum context length is 500000 tokens` — erro de
 * ITEM, transcrição grande demais — casaria com o marcador '500' e viraria
 * `systemic`, girando na fila por horas em vez de falhar de uma vez.
 *
 * Desconhecido cai em `item` DE PROPÓSITO (falha fechada), igual ao módulo da
 * transcrição: tratar o irreconhecível como sistêmico deixaria um job realmente
 * defeituoso girando na fila para sempre.
 */
import {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from 'openai';

export type SummaryErrorClass = 'systemic' | 'item';

/** Backoff do erro sistêmico: 15min. Longo de propósito — quem já respondeu 429
 *  por falta de crédito não muda de ideia em 30s. Espelha SYSTEMIC_BACKOFF_SEC
 *  da transcrição. */
export const SYSTEMIC_BACKOFF_SEC = 900;

/** Idade máxima de um job preso em falha sistêmica. Sem teto de IDADE (o de
 *  tentativas não se aplica ao sistêmico, que não as consome) a fila cresceria
 *  para sempre num apagão longo. */
export const SYSTEMIC_MAX_AGE_H = 72;

/**
 * Status HTTP do AMBIENTE. 408/409/429 e todo 5xx são transitórios; 401/403 são
 * chave revogada ou sem permissão — também ambiente, e o mesmo episódio resume
 * normalmente quando alguém conserta a conta.
 *
 * Fora desta lista fica o 4xx de PEDIDO (400 body inválido, 404 modelo
 * inexistente, 422): retentar não muda nada, então consome tentativa.
 */
function systemicByStatus(status: number | undefined): boolean {
  if (status == null) return false;
  if (status >= 500) return true;
  return status === 401 || status === 403 || status === 408 || status === 409 || status === 429;
}

export function classifySummaryError(err: unknown): SummaryErrorClass {
  // Rede: DNS, conexão recusada, timeout do próprio SDK. Ambiente, sempre.
  if (err instanceof APIConnectionTimeoutError || err instanceof APIConnectionError) return 'systemic';
  // Abort nosso (o timeout de requisição do provider) — o modelo pode responder
  // na próxima; tratar como ambiente evita queimar tentativa num pico de latência.
  if (err instanceof APIUserAbortError) return 'systemic';
  if (err instanceof APIError) return systemicByStatus(err.status) ? 'systemic' : 'item';
  return 'item';
}

/** Falta de conteúdo utilizável classificada como retentável ou não.
 *  `parse_error` = o modelo não devolveu JSON válido no formato esperado: é
 *  falha transitória de geração, retenta. `empty` = JSON válido declarando que
 *  não há o que resumir: é resposta legítima, encerra o job. Sem essa distinção,
 *  uma resposta truncada seria indistinguível de reunião sem conteúdo e nunca
 *  seria retentada (achado #5 da revisão do Codex). */
export type DigestOutcome = 'ok' | 'empty' | 'parse_error';
