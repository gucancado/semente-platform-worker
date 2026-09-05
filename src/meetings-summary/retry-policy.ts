/**
 * src/meetings-summary/retry-policy.ts
 *
 * A DECISÃO de o que fazer com um job depois de uma tentativa. PURA: sem pg, sem
 * config, sem rede — dá para testar sem Postgres, que é o ponto (as suítes
 * `*.db.test.ts` deste repo não rodam sem banco local, e é justamente aqui que
 * moram os dois modos de falha que a revisão do spec levantou).
 *
 * Constantes de política vêm de ./db.js e ./error-class.js, que também são
 * livres de env.
 */
import { SYSTEMIC_BACKOFF_SEC, SYSTEMIC_MAX_AGE_H } from './error-class.js';
import type { SummaryErrorClass } from './error-class.js';
import type { DigestParse } from './prompt.js';

/** Backoff padrão de falha de ITEM (a de AMBIENTE usa SYSTEMIC_BACKOFF_SEC). */
export const ITEM_BACKOFF_SEC = 300;

/** Tentativas antes de desistir de vez. Só falha de ITEM consome tentativa. */
export const MAX_ATTEMPTS = 4;

export type JobOutcome =
  | { action: 'save' }
  | { action: 'close_empty'; reason: string }
  | { action: 'retry'; backoffSec: number; consumeAttempt: boolean; reason: string }
  | { action: 'fail'; reason: string };

/**
 * Traduz o resultado de uma tentativa em ação sobre o job. PURA de propósito.
 *
 * Regras que não são óbvias:
 *   - `parse_error` RETENTA. Antes da revisão, todo digest ausente virava `done`
 *     sob a premissa "a reunião não tinha conteúdo" — o que tornava uma resposta
 *     truncada indistinguível de uma reunião vazia, e ela nunca seria retentada.
 *   - `finish_reason === 'length'` é a mesma coisa por outro caminho: o JSON veio
 *     cortado pelo teto de saída. Retenta.
 *   - falha de AMBIENTE não consome tentativa, mas tem teto de IDADE — senão a
 *     fila cresce para sempre num apagão longo.
 */
export function nextJobOutcome(a: {
  parse?: DigestParse;
  finishReason?: string | null;
  errorClass?: SummaryErrorClass;
  errorMessage?: string;
  attempts: number;
  ageHours: number;
  hasTurns: boolean;
}): JobOutcome {
  if (!a.hasTurns) return { action: 'close_empty', reason: 'sem turnos' };

  if (a.errorClass) {
    const msg = a.errorMessage ?? 'erro';
    if (a.errorClass === 'systemic') {
      if (a.ageHours > SYSTEMIC_MAX_AGE_H) {
        return { action: 'fail', reason: `falha sistêmica por mais de ${SYSTEMIC_MAX_AGE_H}h: ${msg}` };
      }
      return { action: 'retry', backoffSec: SYSTEMIC_BACKOFF_SEC, consumeAttempt: false, reason: msg };
    }
    if (a.attempts >= MAX_ATTEMPTS) return { action: 'fail', reason: msg };
    return { action: 'retry', backoffSec: ITEM_BACKOFF_SEC, consumeAttempt: true, reason: msg };
  }

  const truncated = a.finishReason === 'length';
  const parseFailed = a.parse?.outcome === 'parse_error';
  if (truncated || parseFailed) {
    const reason = truncated ? 'resposta truncada (finish_reason=length)' : 'JSON inválido do modelo';
    if (a.attempts >= MAX_ATTEMPTS) return { action: 'fail', reason };
    return { action: 'retry', backoffSec: ITEM_BACKOFF_SEC, consumeAttempt: true, reason };
  }

  if (a.parse?.outcome === 'empty') {
    return { action: 'close_empty', reason: 'modelo não encontrou conteúdo para resumir' };
  }
  return { action: 'save' };
}
