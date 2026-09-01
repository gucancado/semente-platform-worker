/**
 * src/whatsapp/ai-sweep-health.ts
 *
 * Leitura de saúde do run de julgamento. PURO.
 *
 * POR QUE: entre 2026-08-25 e 31 o runner rodou todo dia às 03:00, chamou o LLM
 * 200 vezes, tomou 429 nas 200 e concluiu `applied:0` — em log level INFO, junto
 * com os runs saudáveis. Sete dias de triagem parada passaram despercebidos
 * porque o resumo de um run 100% quebrado tem exatamente o mesmo formato do
 * resumo de um run em que a IA decidiu não agir.
 *
 * A distinção que faltava: `applied:0` com `errors:0` é uma DECISÃO do motor
 * (legítima); `errors == processed` é infraestrutura quebrada. Só a segunda
 * merece log de erro — e é ela que precisa ser visível no primeiro dia.
 */

export interface SweepCounts {
  processed: number;
  applied: number;
  errors: number;
}

export type SweepHealthLevel = 'ok' | 'degraded' | 'outage';

export interface SweepHealth {
  level: SweepHealthLevel;
  reason: string;
  /** Fração de conversas que falharam (0–1). */
  errorRate: number;
}

/** Acima disto, o run é considerado degradado. Abaixo, erro pontual é ruído normal
 *  (um prompt que não serializa, um timeout solto) e não deve gritar. */
const DEGRADED_THRESHOLD = 0.5;

export function assessSweepHealth(c: SweepCounts): SweepHealth {
  if (c.processed <= 0) {
    return { level: 'ok', reason: 'nada pendente', errorRate: 0 };
  }
  const errorRate = c.errors / c.processed;

  if (c.errors >= c.processed) {
    return {
      level: 'outage',
      reason: `todas as ${c.processed} conversas falharam — provedor de LLM indisponível ou sem crédito`,
      errorRate: 1,
    };
  }
  if (errorRate >= DEGRADED_THRESHOLD) {
    return {
      level: 'degraded',
      reason: `${c.errors}/${c.processed} conversas falharam`,
      errorRate,
    };
  }
  return { level: 'ok', reason: 'run saudável', errorRate };
}
