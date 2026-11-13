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
import { classifyLlmError } from '../llm/errors.js';

export type SummaryErrorClass = 'systemic' | 'item';

/** Backoff do erro sistêmico: 15min. Longo de propósito — quem já respondeu 429
 *  por falta de crédito não muda de ideia em 30s. Espelha SYSTEMIC_BACKOFF_SEC
 *  da transcrição. */
export const SYSTEMIC_BACKOFF_SEC = 900;

/** Idade máxima de um job preso em falha sistêmica. Sem teto de IDADE (o de
 *  tentativas não se aplica ao sistêmico, que não as consome) a fila cresceria
 *  para sempre num apagão longo. 30 dias e não 72h: a falta de crédito de
 *  29/09–02/10/2026 durou 75h e o digest de uma reunião virou falha PERMANENTE
 *  por 3h de diferença, exigindo reprocesso manual. Um digest atrasado ainda vale. */
export const SYSTEMIC_MAX_AGE_H = 720;

/**
 * Classificação pelo erro ESTRUTURADO dos DOIS SDKs (OpenAI e Anthropic) — a
 * regra mora em src/llm/errors.ts, compartilhada com a recuperação de reunião
 * pela gravação (que segue na OpenAI). Crédito esgotado nos dois provedores é
 * `systemic`.
 */
export function classifySummaryError(err: unknown): SummaryErrorClass {
  return classifyLlmError(err);
}

/** Falta de conteúdo utilizável classificada como retentável ou não.
 *  `parse_error` = o modelo não devolveu JSON válido no formato esperado: é
 *  falha transitória de geração, retenta. `empty` = JSON válido declarando que
 *  não há o que resumir: é resposta legítima, encerra o job. Sem essa distinção,
 *  uma resposta truncada seria indistinguível de reunião sem conteúdo e nunca
 *  seria retentada (achado #5 da revisão do Codex). */
export type DigestOutcome = 'ok' | 'empty' | 'parse_error';
