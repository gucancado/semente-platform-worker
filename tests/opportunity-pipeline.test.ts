/**
 * tests/opportunity-pipeline.test.ts
 *
 * Testes PUROS (sem Postgres nem env de servidor) do poller de criação (Fase B,
 * Task B1):
 *   - runCreationSweep: shape do SQL de candidatos (pipeline_since, IS DISTINCT
 *     FROM FALSE, os 3 NOT EXISTS) e a iteração 1-query-por-workspace-com-settings;
 *     contagem created/skipped end-to-end com um fake pool completo (query
 *     top-level + connect() pro lock do createOpportunityV3); erro num workspace
 *     loga warn e segue pros demais.
 *   - resolvePollIntervalMs: explicit > env > default.
 *   - startCreationPoller: flag in-flight (2 ticks simultâneos → 1 sweep).
 *
 * opportunity-pipeline.ts só importa tipos de 'pg' + opportunities.ts (que só
 * importa tipos + módulos puros) — não carrega config.js/env de servidor, então
 * roda local sem DATABASE_URL.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runCreationSweep,
  startCreationPoller,
  resolvePollIntervalMs,
} from '../src/whatsapp/opportunity-pipeline.js';

// ── fake pool completo: query() top-level (settings + candidatos) + connect()
//    (BEGIN/lock/count/INSERT/COMMIT do createOpportunityV3 sob o lock) ──────
function fakePoolFull(opts: {
  settingsRows: { workspace_id: string; pipeline_since: string }[];
  candidatesByWorkspace: Record<string, { whatsapp_number_id: number; identifier: string; workspace_id: string }[]>;
  anyCountByPair?: Record<string, number>;
  failWorkspaces?: Set<string>;
}) {
  const poolCalls: { text: string; params: any[] }[] = [];
  const clientCalls: { text: string; params: any[] }[] = [];
  let nextOppId = 1;
  const client = {
    query(text: string, params: any[] = []) {
      clientCalls.push({ text, params });
      if (/SELECT COUNT\(\*\)::int AS n FROM whatsapp_opportunities/.test(text)) {
        const key = `${params[0]}:${params[1]}`;
        return Promise.resolve({ rows: [{ n: opts.anyCountByPair?.[key] ?? 0 }], rowCount: 1 });
      }
      if (/INSERT INTO whatsapp_opportunities/.test(text)) {
        const id = nextOppId++;
        return Promise.resolve({ rows: [{ id }], rowCount: 1 });
      }
      if (/^SELECT o\.\*/.test(text)) {
        return Promise.resolve({
          rows: [{
            id: 1, identifier: 'c', title: null, status: 'em_andamento',
            is_qualified: null, loss_reason: null, created_at: new Date(), updated_at: new Date(),
            closed_at: null, created_by: 'system', tags: [],
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 }); // BEGIN / pg_advisory_xact_lock / COMMIT
    },
    release() {},
  };
  const pool = {
    query(text: string, params: any[] = []) {
      poolCalls.push({ text, params });
      if (/FROM whatsapp_workspace_settings/.test(text)) {
        return Promise.resolve({ rows: opts.settingsRows, rowCount: opts.settingsRows.length });
      }
      // query de candidatos: $1 = workspace_id
      const workspaceId = params[0];
      if (opts.failWorkspaces?.has(workspaceId)) return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: opts.candidatesByWorkspace[workspaceId] ?? [], rowCount: 0 });
    },
    connect() { return Promise.resolve(client); },
  } as any;
  return { pool, poolCalls, clientCalls };
}

// =============================================================================
// runCreationSweep — shape do SQL de candidatos
// =============================================================================

test('runCreationSweep: query de candidatos — pipeline_since, IS DISTINCT FROM FALSE, 3 NOT EXISTS', async () => {
  const { pool, poolCalls } = fakePoolFull({
    settingsRows: [{ workspace_id: 'ws-1', pipeline_since: '2026-07-01T00:00:00Z' }],
    candidatesByWorkspace: {},
  });
  const result = await runCreationSweep(pool);
  assert.deepEqual(result, { created: 0, skipped: 0 });

  const settingsCall = poolCalls.find((c) => /FROM whatsapp_workspace_settings/.test(c.text));
  assert.ok(settingsCall, 'lê workspace_id + pipeline_since numa query só');
  assert.match(settingsCall!.text, /SELECT workspace_id, pipeline_since/);

  const candidatesCall = poolCalls.find((c) => /FROM messages m\b/.test(c.text));
  assert.ok(candidatesCall, 'roda a query de candidatos');
  assert.deepEqual(candidatesCall!.params, ['ws-1', '2026-07-01T00:00:00Z']);
  assert.match(candidatesCall!.text, /tm\.is_lead IS DISTINCT FROM FALSE/);
  assert.match(candidatesCall!.text, /NOT EXISTS \(\s*SELECT 1 FROM whatsapp_opportunities o/);
  assert.match(candidatesCall!.text, /NOT EXISTS \(\s*SELECT 1 FROM whatsapp_groups g/);
  assert.match(candidatesCall!.text, /NOT EXISTS \(\s*SELECT 1 FROM messages m2[\s\S]*m2\.author IS NOT NULL/);
});

test('runCreationSweep: 1 query de candidatos POR workspace com settings (não mistura pipeline_since)', async () => {
  const { pool, poolCalls } = fakePoolFull({
    settingsRows: [
      { workspace_id: 'ws-1', pipeline_since: 'T1' },
      { workspace_id: 'ws-2', pipeline_since: 'T2' },
    ],
    candidatesByWorkspace: {},
  });
  await runCreationSweep(pool);
  const candidateCalls = poolCalls.filter((c) => /FROM messages m\b/.test(c.text));
  assert.equal(candidateCalls.length, 2);
  assert.deepEqual(candidateCalls.map((c) => c.params), [['ws-1', 'T1'], ['ws-2', 'T2']]);
});

// =============================================================================
// runCreationSweep — contagem created/skipped end-to-end (fake pool completo)
// =============================================================================

test('runCreationSweep: candidato sem opp existente → cria via createOpportunityV3(skipIfAnyOpportunity, system)', async () => {
  const { pool, clientCalls } = fakePoolFull({
    settingsRows: [{ workspace_id: 'ws-1', pipeline_since: 'T1' }],
    candidatesByWorkspace: { 'ws-1': [{ whatsapp_number_id: 9, identifier: 'c', workspace_id: 'ws-1' }] },
  });
  const result = await runCreationSweep(pool);
  assert.deepEqual(result, { created: 1, skipped: 0 });
  const insertCall = clientCalls.find((c) => /INSERT INTO whatsapp_opportunities/.test(c.text));
  assert.ok(insertCall, 'deve inserir a opp');
  assert.equal(insertCall!.params.at(-1), 'system', 'created_by = system');
  const countCall = clientCalls.find((c) => /SELECT COUNT\(\*\)::int AS n FROM whatsapp_opportunities/.test(c.text));
  assert.ok(countCall, 'a re-checagem (skipIfAnyOpportunity) roda dentro da tx');
});

test('runCreationSweep: candidato que já ganhou opp na corrida (anyCount>0) → skipped, sem INSERT', async () => {
  const { pool, clientCalls } = fakePoolFull({
    settingsRows: [{ workspace_id: 'ws-1', pipeline_since: 'T1' }],
    candidatesByWorkspace: { 'ws-1': [{ whatsapp_number_id: 9, identifier: 'c', workspace_id: 'ws-1' }] },
    anyCountByPair: { '9:c': 1 },
  });
  const result = await runCreationSweep(pool);
  assert.deepEqual(result, { created: 0, skipped: 1 });
  assert.equal(clientCalls.some((c) => /INSERT INTO whatsapp_opportunities/.test(c.text)), false,
    'não insere quando a re-checagem dentro do lock acha uma opp do par');
});

test('runCreationSweep: erro num workspace loga warn e segue pros demais (best-effort)', async () => {
  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnCalls.push(args); };
  try {
    const { pool } = fakePoolFull({
      settingsRows: [
        { workspace_id: 'ws-bad', pipeline_since: 'T1' },
        { workspace_id: 'ws-ok', pipeline_since: 'T2' },
      ],
      candidatesByWorkspace: {},
      failWorkspaces: new Set(['ws-bad']),
    });
    const result = await runCreationSweep(pool);
    assert.deepEqual(result, { created: 0, skipped: 0 });
    assert.equal(warnCalls.length, 1, 'workspace ok deve seguir sem gerar warn');
    assert.match(String(warnCalls[0]![0]), /ws-bad/);
  } finally {
    console.warn = originalWarn;
  }
});

// =============================================================================
// resolvePollIntervalMs — explicit > env > default
// =============================================================================

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.CRM_CREATION_POLL_MS;
  if (value === undefined) delete process.env.CRM_CREATION_POLL_MS;
  else process.env.CRM_CREATION_POLL_MS = value;
  try { fn(); }
  finally {
    if (prev === undefined) delete process.env.CRM_CREATION_POLL_MS;
    else process.env.CRM_CREATION_POLL_MS = prev;
  }
}

test('resolvePollIntervalMs: param explicit sempre vence, mesmo com env setada', () => {
  withEnv('999', () => {
    assert.equal(resolvePollIntervalMs(1234), 1234);
  });
});

test('resolvePollIntervalMs: sem explicit, lê CRM_CREATION_POLL_MS válida', () => {
  withEnv('60000', () => {
    assert.equal(resolvePollIntervalMs(), 60_000);
  });
});

test('resolvePollIntervalMs: env ausente ou inválida (não-numérica/<=0) → default 5min', () => {
  withEnv(undefined, () => {
    assert.equal(resolvePollIntervalMs(), 5 * 60_000);
  });
  withEnv('lixo', () => {
    assert.equal(resolvePollIntervalMs(), 5 * 60_000);
  });
  withEnv('0', () => {
    assert.equal(resolvePollIntervalMs(), 5 * 60_000);
  });
  withEnv('-100', () => {
    assert.equal(resolvePollIntervalMs(), 5 * 60_000);
  });
});

// =============================================================================
// startCreationPoller — flag in-flight (2 ticks simultâneos → 1 sweep)
// =============================================================================

test('startCreationPoller: 2 ticks simultâneos → só 1 sweep roda por vez (flag in-flight)', async () => {
  let resolveSettingsQuery: (v: unknown) => void = () => {};
  let queryCalls = 0;
  const pool = {
    query() {
      queryCalls++;
      return new Promise((resolve) => { resolveSettingsQuery = resolve; });
    },
  } as any;

  const realSetInterval = global.setInterval;
  let capturedFn: (() => Promise<void>) | undefined;
  (global as any).setInterval = ((fn: any) => { capturedFn = fn; return 0 as unknown as NodeJS.Timeout; }) as any;
  try {
    startCreationPoller(pool, 1000);
  } finally {
    global.setInterval = realSetInterval;
  }
  assert.ok(capturedFn, 'setInterval deve ter sido chamado com a função de tick');

  const p1 = capturedFn!();
  const p2 = capturedFn!(); // 2º tick durante o 1º em andamento → deve ser no-op (guard in-flight)
  resolveSettingsQuery({ rows: [] }); // libera a query pendente do 1º tick
  await p1;
  await p2;
  assert.equal(queryCalls, 1, 'o 2º tick não deve iniciar nova query enquanto o 1º está em andamento');
});
