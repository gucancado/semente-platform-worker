/**
 * src/transcription/breaker.ts
 *
 * Circuit breaker da fila de transcrição. PURO (relógio injetado) — o poller só
 * consulta `isOpen()` antes de claimar o próximo batch.
 *
 * Existe porque "não consumir tentativa em falha sistêmica" (error-class.ts),
 * sozinho, resolve a PERDA mas não o DESPERDÍCIO: com 1.000 jobs na fila e o
 * provedor devolvendo 429, o poller (batch 20 a cada 5s) dispararia milhares de
 * chamadas por hora contra uma API que já disse não. O breaker faz a primeira
 * falha sistêmica pausar a fila INTEIRA por um cooldown, e a fila volta sozinha
 * quando ele vence — sem intervenção humana, que é o ponto.
 *
 * O estado é de processo (some no restart, e tudo bem): reiniciar só faz o
 * primeiro tick tentar de novo, e se o ambiente ainda estiver quebrado o breaker
 * reabre no mesmo instante.
 */

export interface CircuitBreakerState {
  openUntil: number;
  reason: string | null;
  /** Rajadas sistêmicas desde o último sucesso — cresce durante um apagão longo. */
  consecutive: number;
}

export interface CircuitBreaker {
  isOpen(now?: number): boolean;
  trip(reason: string, now?: number): void;
  recordSuccess(): void;
  state(): CircuitBreakerState;
}

export function createCircuitBreaker(opts: { cooldownMs: number }): CircuitBreaker {
  let openUntil = 0;
  let reason: string | null = null;
  let consecutive = 0;

  return {
    isOpen(now = Date.now()) {
      return now < openUntil;
    },
    trip(r, now = Date.now()) {
      openUntil = now + opts.cooldownMs;
      reason = r;
      consecutive += 1;
    },
    recordSuccess() {
      consecutive = 0;
    },
    state() {
      return { openUntil, reason, consecutive };
    },
  };
}
