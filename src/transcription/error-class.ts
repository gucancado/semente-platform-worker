/**
 * src/transcription/error-class.ts
 *
 * Classificação da falha de transcrição e plano de retry. PURO (sem pg, sem env)
 * — a política mora aqui e `markTranscriptionRetryOrFail` (db.ts) só aplica.
 *
 * POR QUE ISTO EXISTE (incidente 2026-08-24 → 31): a conta OpenAI ficou sem
 * crédito e todo job de áudio tomou `429 You have no credits remaining`. Como o
 * retry antigo tratava QUALQUER erro igual, cada job gastou as 4 tentativas em
 * minutos e virou `failed` PERMANENTE — 1.002 áudios que só voltaram por UPDATE
 * manual, 7 dias depois. E como a transcrição alimenta a triagem do CRM, o motor
 * de IA julgou 169 conversas lendo `[áudio — transcrição indisponível]` no lugar
 * da fala do cliente.
 *
 * A distinção que conserta isso: a culpa é do AMBIENTE ou deste ÁUDIO?
 *   - `systemic` — conta sem crédito, chave revogada, provedor 5xx, rede caindo.
 *     O mesmo áudio transcreve normalmente quando o ambiente voltar, então
 *     **não consome tentativa**: o job fica pendente com backoff longo e se cura
 *     sozinho. Um teto de IDADE (não de tentativas) evita fila eterna.
 *   - `item` — áudio corrompido, formato não suportado, mídia não descriptografada.
 *     Retentar não muda nada; segue a política antiga de attempts/maxAttempts.
 *
 * Desconhecido cai em `item` DE PROPÓSITO (falha fechada): tratar o que não
 * reconhecemos como sistêmico deixaria um job genuinamente defeituoso girando na
 * fila para sempre. Erro sistêmico novo apenas mantém o comportamento antigo.
 */

export type TranscriptionErrorClass = 'systemic' | 'item';

/** Backoff do erro sistêmico: 15min. Longo de propósito — quem já respondeu 429
 *  por falta de crédito não muda de ideia em 30s, e o breaker do poller ainda
 *  segura a fila inteira por cima disto. */
export const SYSTEMIC_BACKOFF_SEC = 900;

/** Sinais de erro do AMBIENTE. Ordem não importa (todos são substring match no
 *  texto normalizado). Mantido explícito em vez de regex esperta: a lista é lida
 *  por quem depura um incidente às 3h da manhã. */
const SYSTEMIC_MARKERS = [
  '429', // rate limit E "no credits remaining" — os dois são do ambiente
  '401',
  '403',
  '500',
  '502',
  '503',
  '504',
  'no credits',
  'insufficient_quota',
  'rate limit',
  'server had an error',
  'service unavailable',
  'overloaded',
  'fetch failed',
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'socket hang up',
  'network error',
];

export function classifyTranscriptionError(message: string): TranscriptionErrorClass {
  const m = (message ?? '').toLowerCase();
  return SYSTEMIC_MARKERS.some((s) => m.includes(s)) ? 'systemic' : 'item';
}

export interface RetryPlanInput {
  error: string;
  /** attempts JÁ incrementado pelo claim (`claimDueTranscriptionJobs`). */
  attempts: number;
  maxAttempts: number;
  /** Idade do job em horas (now − created_at). Só pesa no caso sistêmico. */
  ageH: number;
  /** Teto de idade do caso sistêmico: passou disto, desiste de vez. */
  systemicMaxAgeH: number;
}

export interface RetryPlan {
  action: 'retry' | 'fail';
  systemic: boolean;
  /** Segundos até a próxima tentativa (só quando action='retry'). */
  backoffSec: number;
  /** false = devolver a tentativa que o claim consumiu (caso sistêmico). */
  consumesAttempt: boolean;
}

export function planTranscriptionRetry(input: RetryPlanInput): RetryPlan {
  const systemic = classifyTranscriptionError(input.error) === 'systemic';

  if (systemic) {
    // Teto por IDADE, não por tentativas: um apagão de provedor pode durar horas
    // sem que isso seja culpa do job. Passando do teto, vira falha terminal pra
    // não acumular fila-zumbi indefinidamente.
    if (input.ageH > input.systemicMaxAgeH) {
      return { action: 'fail', systemic: true, backoffSec: 0, consumesAttempt: false };
    }
    return { action: 'retry', systemic: true, backoffSec: SYSTEMIC_BACKOFF_SEC, consumesAttempt: false };
  }

  if (input.attempts >= input.maxAttempts) {
    return { action: 'fail', systemic: false, backoffSec: 0, consumesAttempt: true };
  }
  // Política antiga preservada byte a byte: 30s por tentativa, teto de 5min.
  return {
    action: 'retry',
    systemic: false,
    backoffSec: Math.min(input.attempts * 30, 300),
    consumesAttempt: true,
  };
}
