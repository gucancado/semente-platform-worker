/**
 * tests/whatsapp/ai-judgment-runner.test.ts  (PURO — fake pool + provider/deps injetados)
 *
 * Prova a ORQUESTRAÇÃO do runner do julgamento IA (Task D5, spec v3 §7):
 *   - fetchAiWorkspaces / fetchPendingConversations: shape do SQL (ai_engine_enabled,
 *     COALESCE watermark/pipeline_since, is_lead IS DISTINCT FROM FALSE, DM NOT EXISTS,
 *     ORDER BY DESC + LIMIT);
 *   - isWithinJudgmentWindow / saoPauloHour: janela [03:00,04:00) BRT via Intl com
 *     timestamps FIXOS;
 *   - resolveTickIntervalMs / resolveMaxConversationsPerRun: explicit > env > default;
 *   - runJudgmentForConversation: decisão válida aplica + registra custo; decisão
 *     inválida → skip + registra custo (o custo aconteceu); sem mensagem → sem LLM;
 *   - runJudgmentSweep: cap com ordenação global (mais quentes primeiro, corta+loga);
 *     erro de LLM numa conversa → errors++ e segue; provider mockado end-to-end;
 *   - startJudgmentRunner: gate de janela (fora → no-op) + flag in-flight.
 *
 * ai-judgment-runner.ts lê CRM_AI_* de process.env (sem config.js) e a cadeia D3/D4 é
 * config-free → roda local sem DATABASE_URL. Os colaboradores pesados (contexto/prompt/
 * validador/aplicador/provider) são injetados.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import {
  fetchAiWorkspaces,
  fetchPendingConversations,
  isWithinJudgmentWindow,
  saoPauloHour,
  resolveTickIntervalMs,
  resolveMaxConversationsPerRun,
  runJudgmentForConversation,
  runJudgmentSweep,
  startJudgmentRunner,
  type PendingConversation,
  type RunJudgmentDeps,
  type RunSweepDeps,
} from '../../src/whatsapp/ai-judgment-runner.js';
import type { JudgmentContext } from '../../src/whatsapp/ai-judgment-context.js';
import type { JudgmentLlm } from '../../src/whatsapp/ai-llm.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function fakePool(handler: (sql: string, params: any[]) => { rows: any[]; rowCount?: number }) {
  const calls: { sql: string; params: any[] }[] = [];
  const pool = {
    query(sql: string, params: any[] = []) {
      calls.push({ sql, params });
      const res = handler(sql, params);
      return Promise.resolve({ rows: res.rows, rowCount: res.rowCount ?? res.rows.length });
    },
  } as unknown as Pool;
  return { pool, calls };
}

function fakeProvider(over: Partial<JudgmentLlm> & { raw?: string; throwErr?: Error } = {}): JudgmentLlm {
  return {
    model: over.model ?? 'gpt-4o-mini',
    provider: over.provider ?? 'openai',
    judge: over.judge ?? (async () => {
      if (over.throwErr) throw over.throwErr;
      return { raw: over.raw ?? '{}', usage: { inputTokens: 100, outputTokens: 20 } };
    }),
  };
}

function baseCtx(over: Partial<JudgmentContext> = {}): JudgmentContext {
  return {
    numberId: 1, identifier: 'c', workspaceId: 'ws',
    watermark: null, lastMessageAt: '2026-07-30T10:00:00.000Z',
    messages: [{ direction: 'inbound', text: 'oi', createdAt: '2026-07-30T10:00:00.000Z' }],
    triage: { isLead: null, leadSource: null, notes: null },
    openOpp: null, lastClosedOpp: null,
    settings: { newOppAfterDays: 30, aiLeadGuidance: null, aiQualifiedGuidance: null },
    lossReasons: [], notLeadReasons: [], tags: [],
    sticky: { isLead: false, isQualified: false, status: false, lossReason: false, tagsRemovedByHuman: [] },
    ...over,
  };
}

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { fn(); }
  finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

function captureConsole(kind: 'warn' | 'info', fn: () => Promise<void>): Promise<unknown[][]> {
  const captured: unknown[][] = [];
  const original = console[kind];
  console[kind] = (...args: unknown[]) => { captured.push(args); };
  return fn().then(() => { console[kind] = original; return captured; }, (e) => { console[kind] = original; throw e; });
}

// =============================================================================
// fetchAiWorkspaces / fetchPendingConversations — shape do SQL
// =============================================================================

test('fetchAiWorkspaces: filtra ai_engine_enabled = TRUE, lê workspace_id + pipeline_since', async () => {
  const { pool, calls } = fakePool(() => ({
    rows: [{ workspace_id: 'ws-1', pipeline_since: '2026-07-01T00:00:00Z' }],
  }));
  const rows = await fetchAiWorkspaces(pool);
  assert.deepEqual(rows, [{ workspaceId: 'ws-1', pipelineSince: '2026-07-01T00:00:00Z' }]);
  assert.match(calls[0].sql, /FROM whatsapp_workspace_settings WHERE ai_engine_enabled = TRUE/);
});

test('fetchPendingConversations: COALESCE(watermark, pipeline_since), is_lead≠FALSE, DM, ORDER DESC + LIMIT', async () => {
  const { pool, calls } = fakePool(() => ({
    rows: [{
      whatsapp_number_id: 9, identifier: 'c', workspace_id: 'ws-1',
      last_message_at: '2026-07-30T10:00:00Z', watermark: '2026-07-29T00:00:00Z',
    }],
  }));
  const rows = await fetchPendingConversations(pool, { workspaceId: 'ws-1', pipelineSince: 'PS', limit: 200 });
  assert.deepEqual(rows, [{
    numberId: 9, identifier: 'c', workspaceId: 'ws-1',
    lastMessageAt: '2026-07-30T10:00:00Z', watermark: '2026-07-29T00:00:00Z',
  }]);
  const sql = calls[0].sql;
  assert.deepEqual(calls[0].params, ['ws-1', 'PS', 200]);
  assert.match(sql, /tm\.is_lead IS DISTINCT FROM FALSE/);
  assert.match(sql, /HAVING date_trunc\('milliseconds', MAX\(m\.created_at\)\) > COALESCE\(j\.watermark, \$2::timestamptz\)/);
  assert.match(sql, /input_last_message_at/);
  assert.match(sql, /NOT EXISTS \(\s*SELECT 1 FROM whatsapp_groups g/);
  assert.match(sql, /NOT EXISTS \(\s*SELECT 1 FROM messages m2[\s\S]*m2\.author IS NOT NULL/);
  assert.match(sql, /ORDER BY MAX\(m\.created_at\) DESC\s*LIMIT \$3/);
});

test('fetchPendingConversations: compara na MESMA precisão do watermark gravado (ms), não em µs', async () => {
  // Regressão do bug de 2026-08-10: `input_last_message_at` é gravado a partir de
  // ctx.lastMessageAt, que é uma ISO string de JS (MILISSEGUNDO — o driver do pg trunca
  // os µs ao virar Date). Comparar MAX(created_at) cru (MICROSSEGUNDO) contra esse
  // watermark deixava `.357980 > .357000` eternamente verdadeiro: TODA conversa já
  // julgada voltava como pendente em todo run, o LLM era chamado de novo (custo pago) e
  // o CLAIM caía no UNIQUE → 65% das chamadas viravam lixo. O lado esquerdo TEM que ser
  // truncado pra ms antes da comparação.
  const { pool, calls } = fakePool(() => ({ rows: [] }));
  await fetchPendingConversations(pool, { workspaceId: 'ws-1', pipelineSince: 'PS', limit: 10 });
  const sql = calls[0].sql;
  assert.match(sql, /date_trunc\('milliseconds', MAX\(m\.created_at\)\)/);
  assert.doesNotMatch(sql, /HAVING MAX\(m\.created_at\) >/);
});

test('fetchPendingConversations: watermark NULL (nunca julgado) → null no shape', async () => {
  const { pool } = fakePool(() => ({
    rows: [{ whatsapp_number_id: 9, identifier: 'c', workspace_id: 'ws-1', last_message_at: 'T', watermark: null }],
  }));
  const rows = await fetchPendingConversations(pool, { workspaceId: 'ws-1', pipelineSince: 'PS', limit: 10 });
  assert.equal(rows[0].watermark, null);
});

// =============================================================================
// janela horária BRT (Intl, timestamps fixos)
// =============================================================================

test('saoPauloHour: converte UTC → hora local BRT (UTC-3)', () => {
  assert.equal(saoPauloHour(new Date('2026-07-30T06:30:00Z')), 3);  // 03:30 BRT
  assert.equal(saoPauloHour(new Date('2026-07-30T07:00:00Z')), 4);  // 04:00 BRT
  assert.equal(saoPauloHour(new Date('2026-07-30T05:59:00Z')), 2);  // 02:59 BRT
});

test('isWithinJudgmentWindow: só [03:00, 04:00) BRT é dentro', () => {
  assert.equal(isWithinJudgmentWindow(new Date('2026-07-30T06:00:00Z')), true);   // 03:00 BRT
  assert.equal(isWithinJudgmentWindow(new Date('2026-07-30T06:30:00Z')), true);   // 03:30 BRT
  assert.equal(isWithinJudgmentWindow(new Date('2026-07-30T06:59:59Z')), true);   // 03:59 BRT
  assert.equal(isWithinJudgmentWindow(new Date('2026-07-30T07:00:00Z')), false);  // 04:00 BRT (exclusivo)
  assert.equal(isWithinJudgmentWindow(new Date('2026-07-30T05:59:00Z')), false);  // 02:59 BRT
  assert.equal(isWithinJudgmentWindow(new Date('2026-07-30T15:00:00Z')), false);  // 12:00 BRT
});

// =============================================================================
// resolveTickIntervalMs / resolveMaxConversationsPerRun — explicit > env > default
// =============================================================================

test('resolveTickIntervalMs: explicit vence (sem clamp); env válida ≥15min; default 1h', () => {
  withEnv('CRM_AI_TICK_MS', '999', () => assert.equal(resolveTickIntervalMs(1234), 1234)); // explicit não clampa
  withEnv('CRM_AI_TICK_MS', '1800000', () => assert.equal(resolveTickIntervalMs(), 1_800_000)); // 30min
  withEnv('CRM_AI_TICK_MS', undefined, () => assert.equal(resolveTickIntervalMs(), 60 * 60_000));
  withEnv('CRM_AI_TICK_MS', 'lixo', () => assert.equal(resolveTickIntervalMs(), 60 * 60_000));
  withEnv('CRM_AI_TICK_MS', '0', () => assert.equal(resolveTickIntervalMs(), 60 * 60_000));
});

test('resolveTickIntervalMs: CRM_AI_TICK_MS válido porém < 15min é clampado pra 15min com warn (anti-runaway)', () => {
  const warns: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a); };
  try {
    withEnv('CRM_AI_TICK_MS', '60000', () => assert.equal(resolveTickIntervalMs(), 15 * 60_000)); // 1min → 15min
  } finally { console.warn = orig; }
  assert.equal(warns.length, 1, 'clamp loga warn no boot');
  assert.match(String(warns[0][0]), /abaixo do mínimo/);
});

test('resolveMaxConversationsPerRun: explicit vence; env válida; default 200', () => {
  withEnv('CRM_AI_MAX_CONVERSATIONS_PER_RUN', '999', () => assert.equal(resolveMaxConversationsPerRun(5), 5));
  withEnv('CRM_AI_MAX_CONVERSATIONS_PER_RUN', '50', () => assert.equal(resolveMaxConversationsPerRun(), 50));
  withEnv('CRM_AI_MAX_CONVERSATIONS_PER_RUN', undefined, () => assert.equal(resolveMaxConversationsPerRun(), 200));
  withEnv('CRM_AI_MAX_CONVERSATIONS_PER_RUN', '-3', () => assert.equal(resolveMaxConversationsPerRun(), 200));
});

// =============================================================================
// runJudgmentForConversation — provider mockado end-to-end
// =============================================================================

function metricsPool() {
  const metrics: any[][] = [];
  const pool = {
    query(sql: string, params: any[] = []) {
      if (/INSERT INTO llm_metrics/.test(sql)) metrics.push(params);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as Pool;
  return { pool, metrics };
}

test('runJudgmentForConversation: decisão VÁLIDA aplica (applyFn chamado) + registra custo', async () => {
  const { pool, metrics } = metricsPool();
  let applyCalled = false;
  const deps: RunJudgmentDeps = {
    buildContext: async () => baseCtx(),
    buildPrompt: () => ({ system: 'S', user: 'U' }),
    parseDecision: () => ({ ok: true, decision: { triage: 'lead', notLeadReason: null, openOpp: null, closedAction: null, tags: [], rationale: 'ok' } }),
    applyFn: (async () => { applyCalled = true; return { applied: ['triage:lead'], skipped: [], stale: false }; }) as any,
  };
  const r = await runJudgmentForConversation(pool, fakeProvider(), { numberId: 1, identifier: 'c', workspaceId: 'ws', watermark: null }, deps);
  assert.equal(applyCalled, true);
  assert.deepEqual(r.applied, ['triage:lead']);
  assert.equal(r.judged, true);
  assert.equal(metrics.length, 1, 'custo registrado exatamente 1x');
  // params: [provider, model, tokens_in, tokens_out, cost_usd]
  assert.equal(metrics[0][0], 'openai');
  assert.equal(metrics[0][1], 'gpt-4o-mini');
  assert.equal(metrics[0][2], 100);
  assert.equal(metrics[0][3], 20);
  assert.ok(Number(metrics[0][4]) > 0, 'cost_usd > 0');
});

test('runJudgmentForConversation: decisão INVÁLIDA → skip + custo + grava judgment NÃO-aplicado (watermark avança)', async () => {
  const { pool, metrics } = metricsPool();
  let applyCalled = false;
  let unappliedArgs: any[] | null = null;
  const captured = await captureConsole('warn', async () => {
    const deps: RunJudgmentDeps = {
      buildContext: async () => baseCtx(),
      buildPrompt: () => ({ system: 'S', user: 'U' }),
      parseDecision: () => ({ ok: false, error: 'output não é JSON' }),
      applyFn: (async () => { applyCalled = true; return { applied: [], skipped: [], stale: false }; }) as any,
      recordUnapplied: (async (...args: any[]) => { unappliedArgs = args; return { recorded: true, stale: false }; }) as any,
    };
    const r = await runJudgmentForConversation(pool, fakeProvider({ raw: 'não-json' }), { numberId: 1, identifier: 'c', workspaceId: 'ws', watermark: null }, deps);
    assert.deepEqual(r.skipped, ['invalid_decision']);
    assert.equal(r.judged, true);
    assert.equal(r.stale, false);
  });
  assert.equal(applyCalled, false, 'não aplica quando a decisão é inválida');
  assert.ok(unappliedArgs, 'recordUnapplied chamado no ramo inválido (crava o watermark, anti-runaway)');
  assert.equal(unappliedArgs![2], 'não-json', 'passa o raw do LLM');
  assert.equal(unappliedArgs![3], 'output não é JSON', 'passa o motivo (reason)');
  assert.deepEqual(unappliedArgs![4], { model: 'gpt-4o-mini' }, 'passa o modelo');
  assert.equal(metrics.length, 1, 'custo registrado mesmo com decisão inválida');
  assert.equal(captured.length, 1, 'loga a decisão inválida');
});

test('runJudgmentForConversation: recordUnapplied stale=true propaga pro resultado (mensagem nova sob o lock)', async () => {
  const { pool } = metricsPool();
  const deps: RunJudgmentDeps = {
    buildContext: async () => baseCtx(),
    buildPrompt: () => ({ system: 'S', user: 'U' }),
    parseDecision: () => ({ ok: false, error: 'x' }),
    recordUnapplied: (async () => ({ recorded: false, stale: true })) as any,
  };
  const r = await runJudgmentForConversation(pool, fakeProvider({ raw: 'z' }), { numberId: 1, identifier: 'c', workspaceId: 'ws', watermark: null }, deps);
  assert.equal(r.stale, true);
});

test('runJudgmentForConversation: contexto SEM mensagem → não chama LLM nem registra custo', async () => {
  const { pool, metrics } = metricsPool();
  let judgeCalled = false;
  const provider = fakeProvider({ judge: async () => { judgeCalled = true; return { raw: '{}', usage: { inputTokens: 0, outputTokens: 0 } }; } });
  const deps: RunJudgmentDeps = {
    buildContext: async () => baseCtx({ lastMessageAt: null, messages: [] }),
    buildPrompt: () => ({ system: 'S', user: 'U' }),
  };
  const r = await runJudgmentForConversation(pool, provider, { numberId: 1, identifier: 'c', workspaceId: 'ws', watermark: null }, deps);
  assert.equal(judgeCalled, false);
  assert.equal(r.judged, false);
  assert.deepEqual(r.skipped, ['no_last_message']);
  assert.equal(metrics.length, 0);
});

test('runJudgmentForConversation: prompt recebe o "now" injetado', async () => {
  const { pool } = metricsPool();
  let seenNow = '';
  const deps: RunJudgmentDeps = {
    buildContext: async () => baseCtx(),
    buildPrompt: (_ctx, now) => { seenNow = now; return { system: 'S', user: 'U' }; },
    parseDecision: () => ({ ok: true, decision: { triage: null, notLeadReason: null, openOpp: null, closedAction: null, tags: [], rationale: '' } }),
    applyFn: (async () => ({ applied: [], skipped: [], stale: false })) as any,
    now: () => '2026-07-30T03:00:00.000Z',
  };
  await runJudgmentForConversation(pool, fakeProvider(), { numberId: 1, identifier: 'c', workspaceId: 'ws', watermark: null }, deps);
  assert.equal(seenNow, '2026-07-30T03:00:00.000Z');
});

// =============================================================================
// runJudgmentSweep — cap com ordenação global + erro por conversa
// =============================================================================

function sweepDeps(over: Partial<RunJudgmentDeps> = {}): RunJudgmentDeps {
  return {
    buildContext: async () => baseCtx(),
    buildPrompt: () => ({ system: 'S', user: 'U' }),
    parseDecision: () => ({ ok: true, decision: { triage: null, notLeadReason: null, openOpp: null, closedAction: null, tags: [], rationale: '' } }),
    applyFn: (async () => ({ applied: [], skipped: [], stale: false })) as any,
    recordMetrics: async () => {},
    ...over,
  };
}

function pending(numberId: number, lastMessageAt: string): PendingConversation {
  return { numberId, identifier: `c${numberId}`, workspaceId: 'ws', lastMessageAt, watermark: null };
}

test('runJudgmentSweep: cap corta as mais frias e ordena hottest-first cross-workspace', async () => {
  const pool = {} as unknown as Pool;
  const processed: number[] = [];
  const captured = await captureConsole('info', async () => {
    const result = await runJudgmentSweep(pool, fakeProvider(), {
      maxConversations: 2,
      fetchWorkspaces: async () => [
        { workspaceId: 'ws-1', pipelineSince: 'PS' },
        { workspaceId: 'ws-2', pipelineSince: 'PS' },
      ],
      fetchPending: async (_pool, args) => (args.workspaceId === 'ws-1'
        ? [pending(1, '2026-07-30T01:00:00Z'), pending(2, '2026-07-30T05:00:00Z')]
        : [pending(3, '2026-07-30T09:00:00Z'), pending(4, '2026-07-30T03:00:00Z')]),
      ...sweepDeps({
        buildContext: (async (_p: any, a: any) => { processed.push(a.numberId); return baseCtx(); }) as any,
      }),
    });
    assert.equal(result.processed, 2);
    assert.equal(result.skippedByCap, 2);
  });
  // Ordenação global por lastMessageAt DESC: 09:00 (#3), 05:00 (#2) entram; 03:00/01:00 cortadas.
  assert.deepEqual(processed, [3, 2]);
  assert.equal(captured.length, 1, 'loga o corte do cap');
  assert.match(String(captured[0][0]), /cap 2/);
});

test('runJudgmentSweep: erro de LLM numa conversa → errors++ e segue pras demais', async () => {
  const pool = {} as unknown as Pool;
  let judgeN = 0;
  const provider = fakeProvider({
    judge: async () => { judgeN += 1; if (judgeN === 1) throw new Error('rate limit'); return { raw: '{}', usage: { inputTokens: 1, outputTokens: 1 } }; },
  });
  const captured = await captureConsole('warn', async () => {
    const result = await runJudgmentSweep(pool, provider, {
      fetchWorkspaces: async () => [{ workspaceId: 'ws', pipelineSince: 'PS' }],
      fetchPending: async () => [pending(1, '2026-07-30T05:00:00Z'), pending(2, '2026-07-30T04:00:00Z')],
      ...sweepDeps(),
    });
    assert.equal(result.processed, 2);
    assert.equal(result.errors, 1);
  });
  assert.equal(judgeN, 2, 'a 2ª conversa foi julgada mesmo com a 1ª falhando');
  assert.equal(captured.length, 1);
  assert.match(String(captured[0][0]), /julgamento falhou/);
});

test('runJudgmentSweep: coleta de pendentes falha num workspace → warn e segue pro outro', async () => {
  const pool = {} as unknown as Pool;
  const captured = await captureConsole('warn', async () => {
    const result = await runJudgmentSweep(pool, fakeProvider(), {
      fetchWorkspaces: async () => [
        { workspaceId: 'ws-bad', pipelineSince: 'PS' },
        { workspaceId: 'ws-ok', pipelineSince: 'PS' },
      ],
      fetchPending: async (_pool, args) => {
        if (args.workspaceId === 'ws-bad') throw new Error('boom');
        return [pending(1, '2026-07-30T05:00:00Z')];
      },
      ...sweepDeps(),
    });
    assert.equal(result.processed, 1);
  });
  assert.equal(captured.length, 1);
  assert.match(String(captured[0][0]), /ws-bad/);
});

test('runJudgmentSweep: conta applied e stale por conversa', async () => {
  const pool = {} as unknown as Pool;
  let n = 0;
  const result = await runJudgmentSweep(pool, fakeProvider(), {
    fetchWorkspaces: async () => [{ workspaceId: 'ws', pipelineSince: 'PS' }],
    fetchPending: async () => [pending(1, 'T3'), pending(2, 'T2'), pending(3, 'T1')],
    ...sweepDeps({
      applyFn: (async () => {
        n += 1;
        if (n === 1) return { applied: ['triage:lead'], skipped: [], stale: false };
        if (n === 2) return { applied: [], skipped: [], stale: true };
        return { applied: [], skipped: ['already_judged'], stale: false };
      }) as any,
    }),
  });
  assert.equal(result.applied, 1);
  assert.equal(result.stale, 1);
  assert.equal(result.errors, 0);
  // A 3ª conversa caiu no CLAIM (already_judged): LLM chamado, decisão descartada.
  // Sem esse contador o resumo do run diz "processed 3, applied 1" e o desperdício
  // fica invisível — foi o que escondeu o bug de precisão do watermark por 11 dias.
  assert.equal(result.alreadyJudged, 1);
});

test('runJudgmentSweep: alreadyJudged é 0 quando nada bate no CLAIM (regime saudável)', async () => {
  const pool = {} as unknown as Pool;
  const result = await runJudgmentSweep(pool, fakeProvider(), {
    fetchWorkspaces: async () => [{ workspaceId: 'ws', pipelineSince: 'PS' }],
    fetchPending: async () => [pending(1, 'T2'), pending(2, 'T1')],
    ...sweepDeps({
      applyFn: (async () => ({ applied: ['triage:lead'], skipped: [], stale: false })) as any,
    }),
  });
  assert.equal(result.alreadyJudged, 0);
  assert.equal(result.applied, 2);
});

test('2 runs: decisão inválida grava judgment → 2º run NÃO re-chama o LLM (watermark avançou, anti-runaway)', async () => {
  const pool = {} as unknown as Pool;
  const conv = pending(1, '2026-07-30T05:00:00Z'); // identifier 'c1'
  const judged = new Set<string>(); // pares já julgados (o recordUnapplied fake "crava" o watermark)
  let judgeCalls = 0;
  const provider = fakeProvider({
    judge: async () => { judgeCalls += 1; return { raw: 'não-json', usage: { inputTokens: 1, outputTokens: 1 } }; },
  });
  const deps: RunSweepDeps = {
    fetchWorkspaces: async () => [{ workspaceId: 'ws', pipelineSince: 'PS' }],
    // fetchPending reflete o watermark: uma vez gravado o julgamento, a conversa some da fila.
    fetchPending: async () => (judged.has(`${conv.numberId}:${conv.identifier}`) ? [] : [conv]),
    buildContext: (async (_p: any, a: any) => baseCtx({ numberId: a.numberId, identifier: a.identifier, lastMessageAt: conv.lastMessageAt })) as any,
    buildPrompt: () => ({ system: 'S', user: 'U' }),
    parseDecision: () => ({ ok: false, error: 'não é JSON' }),
    recordUnapplied: (async (_p: any, ctx: any) => { judged.add(`${ctx.numberId}:${ctx.identifier}`); return { recorded: true, stale: false }; }) as any,
    recordMetrics: async () => {},
  };
  await runJudgmentSweep(pool, provider, deps); // 1º run: julga (inválido) + crava watermark
  await runJudgmentSweep(pool, provider, deps); // 2º run: conversa fora da fila → sem LLM
  assert.equal(judgeCalls, 1, 'o LLM foi chamado uma única vez apesar de 2 runs');
});

// =============================================================================
// startJudgmentRunner — gate de janela + flag in-flight
// =============================================================================

function captureSetInterval(fn: () => void): () => Promise<void> {
  const real = global.setInterval;
  let captured: (() => Promise<void>) | undefined;
  (global as any).setInterval = ((f: any) => { captured = f; return 0 as unknown as NodeJS.Timeout; }) as any;
  try { fn(); } finally { global.setInterval = real; }
  if (!captured) throw new Error('setInterval não foi chamado');
  return captured;
}

test('startJudgmentRunner: tick FORA da janela BRT → não roda a sweep', async () => {
  let workspacesFetched = 0;
  const pool = {
    query() { workspacesFetched += 1; return Promise.resolve({ rows: [] }); },
  } as unknown as Pool;
  const tick = captureSetInterval(() => {
    startJudgmentRunner(pool, fakeProvider(), { intervalMs: 1000, now: () => new Date('2026-07-30T15:00:00Z') }); // 12:00 BRT
  });
  await tick();
  assert.equal(workspacesFetched, 0, 'fora da janela nenhuma query roda');
});

test('startJudgmentRunner: dentro da janela → roda a sweep (fetch de workspaces)', async () => {
  let workspacesFetched = 0;
  const pool = {
    query(sql: string) {
      if (/whatsapp_workspace_settings/.test(sql)) workspacesFetched += 1;
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Pool;
  const tick = captureSetInterval(() => {
    startJudgmentRunner(pool, fakeProvider(), { intervalMs: 1000, now: () => new Date('2026-07-30T06:30:00Z') }); // 03:30 BRT
  });
  await tick();
  assert.equal(workspacesFetched, 1);
});

test('startJudgmentRunner: 2 ticks simultâneos dentro da janela → 1 sweep por vez (in-flight)', async () => {
  let resolveQuery: (v: unknown) => void = () => {};
  let queryCalls = 0;
  const pool = {
    query() { queryCalls += 1; return new Promise((resolve) => { resolveQuery = resolve; }); },
  } as unknown as Pool;
  const tick = captureSetInterval(() => {
    startJudgmentRunner(pool, fakeProvider(), { intervalMs: 1000, now: () => new Date('2026-07-30T06:30:00Z') });
  });
  const p1 = tick();
  const p2 = tick(); // 2º durante o 1º em andamento → no-op
  resolveQuery({ rows: [] });
  await p1; await p2;
  assert.equal(queryCalls, 1, 'o 2º tick não inicia nova sweep enquanto a 1ª roda');
});
