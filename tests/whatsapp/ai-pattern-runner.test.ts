/**
 * tests/whatsapp/ai-pattern-runner.test.ts  (PURO — fake pool + provider/deps injetados)
 *
 * Prova a ORQUESTRAÇÃO do runner semanal do nível 2 (Task E3, spec v3 §8):
 *   - previousCompleteWeek / saoPauloWeekday: semana anterior (seg→dom) em BRT,
 *     determinística, com timestamps FIXOS (incl. borda de meia-noite UTC);
 *   - isWithinPatternWindow: só DOMINGO [04:00,05:00) BRT;
 *   - runPatternForWorkspace: claim null → skip; matéria < N → finish sem_materia sem LLM;
 *     válida → apply + finish; inválida → finish invalid SEM apply (mas COM custo);
 *     erro → fail;
 *   - runPatternSweep: agrega desfechos, best-effort;
 *   - startPatternPoller: gate de janela + flag in-flight.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import {
  previousCompleteWeek,
  weekFromStart,
  saoPauloWeekday,
  isWithinPatternWindow,
  runPatternForWorkspace,
  runPatternSweep,
  startPatternPoller,
  type RunPatternDeps,
  type RunPatternSweepDeps,
} from '../../src/whatsapp/ai-pattern-runner.js';
import type { PatternContext } from '../../src/whatsapp/ai-pattern-context.js';
import type { PatternDecision } from '../../src/whatsapp/ai-pattern-prompt.js';
import type { JudgmentLlm } from '../../src/whatsapp/ai-llm.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function fakeProvider(over: Partial<JudgmentLlm> & { raw?: string; throwErr?: Error } = {}): JudgmentLlm {
  return {
    model: over.model ?? 'gpt-4o-mini',
    provider: over.provider ?? 'openai',
    judge: over.judge ?? (async () => {
      if (over.throwErr) throw over.throwErr;
      return { raw: over.raw ?? '{}', usage: { inputTokens: 500, outputTokens: 80 } };
    }),
  };
}

function ctx(over: Partial<PatternContext> = {}): PatternContext {
  return {
    workspaceId: 'ws', periodStart: '2026-07-13', periodEnd: '2026-07-19',
    judgments: [], tags: [], lossReasons: [],
    aggregates: { byOpportunityTag: {}, byLossReason: {}, byOpportunityStatus: {} },
    guidances: { lead: null, qualified: null },
    triageCounts: { judged: 0, toLead: 0, toNotLead: 0 },
    opportunityIds: [],
    lossBackfillCandidates: [],
    ...over,
  };
}

/** N julgamentos triviais (só pra passar o piso MIN_JUDGMENTS). */
function judgments(n: number): PatternContext['judgments'] {
  return Array.from({ length: n }, (_, i) => ({ identifier: `c${i}`, rationale: 'r', applied: [], decidedAt: 'T' }));
}

function decision(over: Partial<PatternDecision> = {}): PatternDecision {
  return {
    newTags: [], editTags: [], newLossReasons: [], editLossReasons: [],
    guidanceSuggestions: [], backfillLossReasons: [], insightSummary: 'resumo', ...over,
  };
}

const okPool = {} as unknown as Pool;

// =============================================================================
// previousCompleteWeek / saoPauloWeekday — BRT determinístico
// =============================================================================

test('previousCompleteWeek: domingo 04:30 BRT → semana anterior seg→dom', () => {
  // 2026-07-26 é domingo; 04:30 BRT = 07:30Z.
  assert.deepEqual(previousCompleteWeek(new Date('2026-07-26T07:30:00Z')), {
    periodStart: '2026-07-13', periodEnd: '2026-07-19',
  });
});

test('previousCompleteWeek: quarta-feira → semana anterior relativa a ela', () => {
  // 2026-07-29 é quarta; 10:00 BRT = 13:00Z. thisMonday=07-27 → prev [07-20, 07-26].
  assert.deepEqual(previousCompleteWeek(new Date('2026-07-29T13:00:00Z')), {
    periodStart: '2026-07-20', periodEnd: '2026-07-26',
  });
});

test('previousCompleteWeek: borda de meia-noite UTC respeita o calendário BRT', () => {
  // 2026-07-27T02:30Z = domingo 23:30 BRT → ainda semana anterior [07-13, 07-19].
  assert.deepEqual(previousCompleteWeek(new Date('2026-07-27T02:30:00Z')).periodStart, '2026-07-13');
  // 2026-07-27T03:30Z = segunda 00:30 BRT → vira nova semana → prev [07-20, 07-26].
  assert.deepEqual(previousCompleteWeek(new Date('2026-07-27T03:30:00Z')), {
    periodStart: '2026-07-20', periodEnd: '2026-07-26',
  });
});

test('saoPauloWeekday: 0=domingo em BRT', () => {
  assert.equal(saoPauloWeekday(new Date('2026-07-26T07:30:00Z')), 0); // domingo
  assert.equal(saoPauloWeekday(new Date('2026-07-25T07:30:00Z')), 6); // sábado
  assert.equal(saoPauloWeekday(new Date('2026-07-29T13:00:00Z')), 3); // quarta
});

test('weekFromStart: periodEnd = periodStart + 6 dias', () => {
  assert.deepEqual(weekFromStart('2026-07-13'), { periodStart: '2026-07-13', periodEnd: '2026-07-19' });
});

// =============================================================================
// isWithinPatternWindow — domingo [04:00, 05:00) BRT
// =============================================================================

test('isWithinPatternWindow: só domingo 04:00–05:00 BRT', () => {
  assert.equal(isWithinPatternWindow(new Date('2026-07-26T07:00:00Z')), true);  // dom 04:00 BRT
  assert.equal(isWithinPatternWindow(new Date('2026-07-26T07:59:00Z')), true);  // dom 04:59 BRT
  assert.equal(isWithinPatternWindow(new Date('2026-07-26T06:30:00Z')), false); // dom 03:30 BRT (fora)
  assert.equal(isWithinPatternWindow(new Date('2026-07-26T08:00:00Z')), false); // dom 05:00 BRT (exclusivo)
  assert.equal(isWithinPatternWindow(new Date('2026-07-25T07:30:00Z')), false); // sábado 04:30 BRT
});

// =============================================================================
// runPatternForWorkspace
// =============================================================================

const target = { workspaceId: 'ws', periodStart: '2026-07-13', periodEnd: '2026-07-19' };

test('runPatternForWorkspace: claim null (já running/done) → skipped_claim, sem contexto/LLM', async () => {
  let builtContext = false;
  let judgeCalled = false;
  const deps: RunPatternDeps = {
    claimRun: async () => null,
    buildContext: (async () => { builtContext = true; return ctx(); }) as any,
  };
  const provider = fakeProvider({ judge: async () => { judgeCalled = true; return { raw: '{}', usage: { inputTokens: 0, outputTokens: 0 } }; } });
  const r = await runPatternForWorkspace(okPool, provider, target, deps);
  assert.equal(r.status, 'skipped_claim');
  assert.equal(builtContext, false);
  assert.equal(judgeCalled, false);
});

test('runPatternForWorkspace: matéria < N → finish {skipped:sem_materia} SEM LLM', async () => {
  let finished: any = null;
  let judgeCalled = false;
  const deps: RunPatternDeps = {
    claimRun: async () => ({ runId: 3, resumed: false }),
    buildContext: (async () => ctx({ judgments: judgments(4) })) as any, // < 5
    finishRun: (async (_p: any, id: number, out: any) => { finished = { id, out }; }) as any,
  };
  const provider = fakeProvider({ judge: async () => { judgeCalled = true; return { raw: '{}', usage: { inputTokens: 0, outputTokens: 0 } }; } });
  const r = await runPatternForWorkspace(okPool, provider, target, deps);
  assert.equal(r.status, 'skipped_no_materia');
  assert.equal(judgeCalled, false, 'não gasta LLM sem matéria');
  assert.equal(finished.id, 3);
  assert.equal(finished.out.skipped, 'sem_materia');
});

test('runPatternForWorkspace: decisão VÁLIDA → apply + finish {decision,applied,skipped} + custo', async () => {
  const metrics: any[] = [];
  let applied: any = null;
  let finished: any = null;
  const dec = decision({ insightSummary: 'ok' });
  const deps: RunPatternDeps = {
    claimRun: async () => ({ runId: 9, resumed: false }),
    buildContext: (async () => ctx({ judgments: judgments(10) })) as any,
    buildPrompt: () => ({ system: 'S', user: 'U' }),
    parseDecision: () => ({ ok: true, decision: dec }),
    applyDecision: (async (_p: any, _c: any, d: any, opts: any) => { applied = { d, opts }; return { applied: ['insight:1'], skipped: ['backfill_loss_reason:not_implemented'] }; }) as any,
    finishRun: (async (_p: any, id: number, out: any) => { finished = { id, out }; }) as any,
    recordMetrics: (async (_p: any, a: any) => { metrics.push(a); }) as any,
    now: () => '2026-07-27T04:00:00.000Z',
  };
  const r = await runPatternForWorkspace(okPool, fakeProvider(), target, deps);
  assert.equal(r.status, 'applied');
  assert.equal(applied.opts.runId, 9, 'apply recebe o runId');
  assert.equal(metrics.length, 1, 'custo registrado 1x');
  assert.ok(Number(metrics[0].costUsd) > 0);
  assert.equal(finished.id, 9);
  assert.deepEqual(finished.out.applied, ['insight:1']);
  assert.deepEqual(finished.out.skipped, ['backfill_loss_reason:not_implemented']);
});

test('runPatternForWorkspace: decisão INVÁLIDA → finish {invalid} SEM apply, mas COM custo', async () => {
  const metrics: any[] = [];
  let applyCalled = false;
  let finished: any = null;
  const orig = console.warn; console.warn = () => {};
  try {
    const deps: RunPatternDeps = {
      claimRun: async () => ({ runId: 5, resumed: false }),
      buildContext: (async () => ctx({ judgments: judgments(10) })) as any,
      buildPrompt: () => ({ system: 'S', user: 'U' }),
      parseDecision: () => ({ ok: false, error: 'insight vazio' }),
      applyDecision: (async () => { applyCalled = true; return { applied: [], skipped: [] }; }) as any,
      finishRun: (async (_p: any, id: number, out: any) => { finished = { id, out }; }) as any,
      recordMetrics: (async (_p: any, a: any) => { metrics.push(a); }) as any,
    };
    const r = await runPatternForWorkspace(okPool, fakeProvider({ raw: 'lixo' }), target, deps);
    assert.equal(r.status, 'invalid');
  } finally { console.warn = orig; }
  assert.equal(applyCalled, false, 'não aplica decisão inválida');
  assert.equal(metrics.length, 1, 'custo registrado MESMO com decisão inválida');
  assert.equal(finished.out.invalid, true);
  assert.equal(finished.out.error, 'insight vazio');
});

test('runPatternForWorkspace: LLM down → failRun, status failed (retomável na próxima semana)', async () => {
  let failed: number | null = null;
  const orig = console.warn; console.warn = () => {};
  try {
    const deps: RunPatternDeps = {
      claimRun: async () => ({ runId: 8, resumed: false }),
      buildContext: (async () => ctx({ judgments: judgments(10) })) as any,
      buildPrompt: () => ({ system: 'S', user: 'U' }),
      failRun: (async (_p: any, id: number) => { failed = id; }) as any,
    };
    const r = await runPatternForWorkspace(okPool, fakeProvider({ throwErr: new Error('LLM 503') }), target, deps);
    assert.equal(r.status, 'failed');
  } finally { console.warn = orig; }
  assert.equal(failed, 8, 'a run é marcada failed pra retomar');
});

// =============================================================================
// runPatternSweep — agregação + best-effort
// =============================================================================

test('runPatternSweep: processa todos os workspaces na MESMA semana e agrega desfechos', async () => {
  const seenPeriods = new Set<string>();
  let claimN = 0;
  const deps: RunPatternSweepDeps = {
    provider: fakeProvider(),
    clock: () => new Date('2026-07-26T07:00:00Z'), // domingo → semana [07-13, 07-19]
    fetchWorkspaces: async () => [
      { workspaceId: 'ws-1', pipelineSince: 'x' },
      { workspaceId: 'ws-2', pipelineSince: 'x' },
      { workspaceId: 'ws-3', pipelineSince: 'x' },
    ],
    claimRun: (async (_p: any, ws: string, ps: string, pe: string) => {
      seenPeriods.add(`${ps}..${pe}`);
      claimN += 1;
      if (ws === 'ws-2') return null; // já running/done
      return { runId: claimN, resumed: false };
    }) as any,
    buildContext: (async () => ctx({ judgments: judgments(3) })) as any, // < 5 → sem_materia
    finishRun: (async () => {}) as any,
  };
  const r = await runPatternSweep(okPool, deps);
  assert.equal(r.workspaces, 3);
  assert.equal(r.skippedClaim, 1, 'ws-2 pulou o claim');
  assert.equal(r.skippedNoMateria, 2, 'ws-1 e ws-3 sem matéria');
  assert.deepEqual([...seenPeriods], ['2026-07-13..2026-07-19'], 'todos na mesma semana anterior');
});

test('runPatternSweep: erro no claim de um workspace → failed++ e segue', async () => {
  const orig = console.warn; console.warn = () => {};
  try {
    const deps: RunPatternSweepDeps = {
      provider: fakeProvider(),
      clock: () => new Date('2026-07-26T07:00:00Z'),
      fetchWorkspaces: async () => [
        { workspaceId: 'ws-bad', pipelineSince: 'x' },
        { workspaceId: 'ws-ok', pipelineSince: 'x' },
      ],
      claimRun: (async (_p: any, ws: string) => {
        if (ws === 'ws-bad') throw new Error('claim DB down');
        return { runId: 1, resumed: false };
      }) as any,
      buildContext: (async () => ctx({ judgments: judgments(3) })) as any,
      finishRun: (async () => {}) as any,
    };
    const r = await runPatternSweep(okPool, deps);
    assert.equal(r.failed, 1);
    assert.equal(r.skippedNoMateria, 1, 'o outro workspace segue');
  } finally { console.warn = orig; }
});

// =============================================================================
// startPatternPoller — gate de janela + in-flight
// =============================================================================

function captureSetInterval(fn: () => void): () => Promise<void> {
  const real = global.setInterval;
  let captured: (() => Promise<void>) | undefined;
  (global as any).setInterval = ((f: any) => { captured = f; return 0 as unknown as NodeJS.Timeout; }) as any;
  try { fn(); } finally { global.setInterval = real; }
  if (!captured) throw new Error('setInterval não foi chamado');
  return captured;
}

test('startPatternPoller: tick FORA da janela (sábado) → não roda a sweep', async () => {
  let fetched = 0;
  const pool = { query() { fetched += 1; return Promise.resolve({ rows: [] }); } } as unknown as Pool;
  const tick = captureSetInterval(() => {
    startPatternPoller(pool, fakeProvider(), { intervalMs: 1000, now: () => new Date('2026-07-25T07:30:00Z') }); // sábado
  });
  await tick();
  assert.equal(fetched, 0);
});

test('startPatternPoller: dentro da janela (domingo 04:30) → roda a sweep (fetch de workspaces)', async () => {
  let fetched = 0;
  const pool = {
    query(sql: string) {
      if (/whatsapp_workspace_settings/.test(sql)) fetched += 1;
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Pool;
  const tick = captureSetInterval(() => {
    startPatternPoller(pool, fakeProvider(), { intervalMs: 1000, now: () => new Date('2026-07-26T07:30:00Z') }); // domingo 04:30 BRT
  });
  await tick();
  assert.equal(fetched, 1);
});

test('startPatternPoller: 2 ticks simultâneos na janela → 1 sweep por vez (in-flight)', async () => {
  let resolveQuery: (v: unknown) => void = () => {};
  let queryCalls = 0;
  const pool = {
    query() { queryCalls += 1; return new Promise((resolve) => { resolveQuery = resolve; }); },
  } as unknown as Pool;
  const tick = captureSetInterval(() => {
    startPatternPoller(pool, fakeProvider(), { intervalMs: 1000, now: () => new Date('2026-07-26T07:30:00Z') });
  });
  const p1 = tick();
  const p2 = tick(); // 2º durante o 1º → no-op
  resolveQuery({ rows: [] });
  await p1; await p2;
  assert.equal(queryCalls, 1, 'o 2º tick não inicia nova sweep enquanto a 1ª roda');
});
