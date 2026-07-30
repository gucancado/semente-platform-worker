/**
 * tests/auto-loss.test.ts
 *
 * Testes PUROS (sem Postgres nem env de servidor) do job de auto-perda por
 * inatividade (Fase B, Task B2):
 *   - lossReasonForLastDirection: mapeamento direction→motivo (3 casos, spec §6).
 *   - runAutoLossSweep: shape do SQL de candidatos (GREATEST com created_at,
 *     desempate ORDER BY created_at DESC, id DESC, make_interval(days=>$2)) e o
 *     filtro `auto_loss_days IS NOT NULL` na query de settings; workspace sem
 *     auto_loss_days não gera query de candidatos (a própria SQL de settings já
 *     filtra); contagem `closed` end-to-end com um fake pool completo (query
 *     top-level de settings/candidatos/head do patch + connect() pro lock do
 *     patchOpportunityV3); patch com {ok:false} loga warn e segue; erro num
 *     workspace loga warn e segue pros demais.
 *   - resolveAutoLossPollIntervalMs: explicit > env > default (1h).
 *   - startAutoLossPoller: flag in-flight (2 ticks simultâneos → 1 sweep).
 *
 * auto-loss.ts só importa tipos de 'pg' + opportunities.ts (kernel+lock, que só
 * importa tipos + módulos puros) + loss-reasons.ts (constantes, só tipo Pool) —
 * não carrega config.js/env de servidor, então roda local sem DATABASE_URL.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runAutoLossSweep,
  startAutoLossPoller,
  resolveAutoLossPollIntervalMs,
  lossReasonForLastDirection,
} from '../src/whatsapp/auto-loss.js';
import { SYSTEM_LOSS_REASONS } from '../src/whatsapp/loss-reasons.js';

const LEAD_NAO_RESPONDEU = SYSTEM_LOSS_REASONS[0].code;
const ATENDENTE_NAO_RESPONDEU = SYSTEM_LOSS_REASONS[1].code;

// =============================================================================
// lossReasonForLastDirection — mapeamento direction→motivo (spec §6)
// =============================================================================

test('lossReasonForLastDirection: outbound (atendente falou por último) → lead_nao_respondeu', () => {
  assert.equal(lossReasonForLastDirection('outbound'), LEAD_NAO_RESPONDEU);
});

test('lossReasonForLastDirection: inbound (lead falou por último) → atendente_nao_respondeu', () => {
  assert.equal(lossReasonForLastDirection('inbound'), ATENDENTE_NAO_RESPONDEU);
});

test('lossReasonForLastDirection: par sem mensagem nenhuma (null) → lead_nao_respondeu (default documentado)', () => {
  assert.equal(lossReasonForLastDirection(null), LEAD_NAO_RESPONDEU);
  assert.equal(lossReasonForLastDirection(undefined), LEAD_NAO_RESPONDEU);
});

// ── fake pool completo: query() top-level (settings + candidatos + head do
//    patch) + connect() (BEGIN/lock/SELECT/UPDATE/INSERT events/COMMIT do
//    patchOpportunityV3 sob o lock). Mantém um mini-estado em memória por
//    opportunity_id pra que o SELECT o.* (chamado ANTES e DEPOIS do UPDATE, com
//    o MESMO texto de query) reflita o estado real, sem depender de contar
//    chamadas por ordem. ──────────────────────────────────────────────────────
function fakePoolFull(opts: {
  settingsRows: { workspace_id: string; auto_loss_days: number }[];
  candidatesByWorkspace: Record<string, { id: number; whatsapp_number_id: number; identifier: string; last_direction: string | null }[]>;
  missingOppIds?: Set<number>; // simula opp sumida entre o SELECT de candidatos e o patch → not_found
  failWorkspaces?: Set<string>;
  // guard: por default a opp está 'em_andamento' e o re-check de inatividade
  // devolve true (segue stale) — simula o "mundo não mudou" entre o SELECT de
  // candidatos e o lock. Overrides simulam as 2 janelas de corrida do fix:
  statusOverrideByOppId?: Record<number, string>; // (a) humano mudou o status (ex.: 'ganho') antes do lock
  stillStaleByOppId?: Record<number, boolean>;    // (b) mensagem nova chegou → guard re-check acha false
}) {
  const poolCalls: { text: string; params: any[] }[] = [];
  const clientCalls: { text: string; params: any[] }[] = [];
  const store = new Map<number, any>();
  for (const list of Object.values(opts.candidatesByWorkspace)) {
    for (const c of list) {
      store.set(c.id, {
        id: c.id, whatsapp_number_id: c.whatsapp_number_id, identifier: c.identifier,
        title: null, status: opts.statusOverrideByOppId?.[c.id] ?? 'em_andamento', is_qualified: null, loss_reason: null,
        created_at: new Date(), updated_at: new Date(), closed_at: null, created_by: 'system', tags: [],
      });
    }
  }
  const client = {
    query(text: string, params: any[] = []) {
      clientCalls.push({ text, params });
      if (/^SELECT o\.\*/.test(text)) {
        const row = store.get(Number(params[0]));
        return Promise.resolve(row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 });
      }
      if (/AS still_stale/.test(text)) {
        // params: [numberId, identifier, createdAt, autoLossDays] — a opp buscada é
        // a única com esse (numberId, identifier) no fixture de teste.
        const row = [...store.values()].find((r) => r.whatsapp_number_id === params[0] && r.identifier === params[1]);
        const stillStale = row ? (opts.stillStaleByOppId?.[row.id] ?? true) : true;
        return Promise.resolve({ rows: [{ still_stale: stillStale }], rowCount: 1 });
      }
      if (/UPDATE whatsapp_opportunities SET/.test(text)) {
        const [id, status, isQualified, , title, lossReason] = params;
        const row = store.get(Number(id));
        if (row) { row.status = status; row.is_qualified = isQualified; row.title = title; row.loss_reason = lossReason; }
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 }); // BEGIN / lock / INSERT events / COMMIT
    },
    release() {},
  };
  const pool = {
    query(text: string, params: any[] = []) {
      poolCalls.push({ text, params });
      if (/FROM whatsapp_workspace_settings/.test(text)) {
        return Promise.resolve({ rows: opts.settingsRows, rowCount: opts.settingsRows.length });
      }
      if (/SELECT whatsapp_number_id, identifier FROM whatsapp_opportunities WHERE id = \$1/.test(text)) {
        const id = Number(params[0]);
        if (opts.missingOppIds?.has(id)) return Promise.resolve({ rows: [], rowCount: 0 });
        const row = store.get(id);
        return Promise.resolve(row
          ? { rows: [{ whatsapp_number_id: row.whatsapp_number_id, identifier: row.identifier }], rowCount: 1 }
          : { rows: [], rowCount: 0 });
      }
      // query de candidatos: $1 = workspace_id
      const workspaceId = params[0];
      if (opts.failWorkspaces?.has(workspaceId)) return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: opts.candidatesByWorkspace[workspaceId] ?? [], rowCount: 0 });
    },
    connect() { return Promise.resolve(client); },
  } as any;
  return { pool, poolCalls, clientCalls, store };
}

// =============================================================================
// runAutoLossSweep — shape do SQL
// =============================================================================

test('runAutoLossSweep: query de settings filtra auto_loss_days IS NOT NULL', async () => {
  const { pool, poolCalls } = fakePoolFull({ settingsRows: [], candidatesByWorkspace: {} });
  const result = await runAutoLossSweep(pool);
  assert.deepEqual(result, { closed: 0 });
  const settingsCall = poolCalls.find((c) => /FROM whatsapp_workspace_settings/.test(c.text));
  assert.ok(settingsCall, 'lê workspace_id + auto_loss_days');
  assert.match(settingsCall!.text, /SELECT workspace_id, auto_loss_days/);
  assert.match(settingsCall!.text, /WHERE auto_loss_days IS NOT NULL/);
});

test('runAutoLossSweep: query de candidatos — GREATEST com created_at, desempate created_at/id DESC, make_interval', async () => {
  const { pool, poolCalls } = fakePoolFull({
    settingsRows: [{ workspace_id: 'ws-1', auto_loss_days: 7 }],
    candidatesByWorkspace: {},
  });
  await runAutoLossSweep(pool);
  const candidatesCall = poolCalls.find((c) => /FROM whatsapp_opportunities o\b/.test(c.text));
  assert.ok(candidatesCall, 'roda a query de candidatos');
  assert.deepEqual(candidatesCall!.params, ['ws-1', 7]);
  assert.match(candidatesCall!.text, /LEFT JOIN LATERAL/);
  // GREATEST aparece na lista de colunas E no WHERE — opp manual numa conversa
  // dormente ganha janela cheia a partir do próprio created_at.
  const greatestOccurrences = candidatesCall!.text.match(/GREATEST\(COALESCE\(last\.max_at, 'epoch'::timestamptz\), o\.created_at\)/g) ?? [];
  assert.equal(greatestOccurrences.length, 2, 'GREATEST(...) deve aparecer no SELECT e no WHERE');
  assert.match(candidatesCall!.text, /ARRAY_AGG\(m\.direction ORDER BY m\.created_at DESC, m\.id DESC\)/);
  assert.match(candidatesCall!.text, /o\.status = 'em_andamento'/);
  assert.match(candidatesCall!.text, /NOW\(\) - make_interval\(days => \$2\)/);
  // Minor 2 do review: simetria com o poller B1 — opp órfã numa thread not_lead
  // não vira "perda" com motivo.
  assert.match(candidatesCall!.text, /LEFT JOIN whatsapp_thread_meta tm/);
  assert.match(candidatesCall!.text, /tm\.is_lead IS DISTINCT FROM FALSE/);
});

test('runAutoLossSweep: workspace sem auto_loss_days não gera query de candidatos (filtro já é da SQL de settings)', async () => {
  // A query real já filtra `auto_loss_days IS NOT NULL` — um workspace com NULL
  // simplesmente não aparece nas rows devolvidas. Simulamos isso devolvendo 0
  // settingsRows e conferimos que nenhuma query de candidatos roda.
  const { pool, poolCalls } = fakePoolFull({ settingsRows: [], candidatesByWorkspace: { 'ws-null': [] } });
  const result = await runAutoLossSweep(pool);
  assert.deepEqual(result, { closed: 0 });
  assert.equal(poolCalls.some((c) => /FROM whatsapp_opportunities o\b/.test(c.text)), false,
    'sem settings rows, nenhuma query de candidatos deve rodar');
});

// =============================================================================
// runAutoLossSweep — contagem closed end-to-end (fake pool completo)
// =============================================================================

test('runAutoLossSweep: candidato com last_direction inbound → fecha via patchOpportunityV3(perdido, atendente_nao_respondeu, system)', async () => {
  const { pool, clientCalls, store } = fakePoolFull({
    settingsRows: [{ workspace_id: 'ws-1', auto_loss_days: 7 }],
    candidatesByWorkspace: { 'ws-1': [{ id: 42, whatsapp_number_id: 9, identifier: 'c', last_direction: 'inbound' }] },
  });
  const result = await runAutoLossSweep(pool);
  assert.deepEqual(result, { closed: 1 });
  const row = store.get(42);
  assert.equal(row.status, 'perdido');
  assert.equal(row.loss_reason, ATENDENTE_NAO_RESPONDEU);
  const updateCall = clientCalls.find((c) => /UPDATE whatsapp_opportunities SET/.test(c.text));
  assert.ok(updateCall, 'deve fazer UPDATE via o kernel do patchOpportunityV3');
  const eventCalls = clientCalls.filter((c) => /INSERT INTO whatsapp_opportunity_events/.test(c.text));
  assert.equal(eventCalls.length, 2, 'status + loss_reason viram 2 eventos');
  for (const ev of eventCalls) assert.equal(ev.params.at(-1), 'system', 'changed_by = system');
});

test('runAutoLossSweep: candidato com last_direction outbound → lead_nao_respondeu', async () => {
  const { pool, store } = fakePoolFull({
    settingsRows: [{ workspace_id: 'ws-1', auto_loss_days: 7 }],
    candidatesByWorkspace: { 'ws-1': [{ id: 7, whatsapp_number_id: 9, identifier: 'c', last_direction: 'outbound' }] },
  });
  const result = await runAutoLossSweep(pool);
  assert.deepEqual(result, { closed: 1 });
  assert.equal(store.get(7).loss_reason, LEAD_NAO_RESPONDEU);
});

// =============================================================================
// runAutoLossSweep — guard sob o lock (fix round 1): mata o clobber de ganho
// (1b) e a corrida com mensagem nova (1a)
// =============================================================================

test('runAutoLossSweep: guard (a) — opp deixou de ser em_andamento (humano marcou ganho) → conflict, SEM UPDATE (não clobbera a venda)', async () => {
  const infoCalls: unknown[][] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => { infoCalls.push(args); };
  try {
    const { pool, clientCalls, store } = fakePoolFull({
      settingsRows: [{ workspace_id: 'ws-1', auto_loss_days: 7 }],
      candidatesByWorkspace: { 'ws-1': [{ id: 55, whatsapp_number_id: 9, identifier: 'c', last_direction: 'inbound' }] },
      // simula: entre o SELECT de candidatos (fora do lock) e o patch, um humano
      // marcou a opp como ganha — o re-read DENTRO do lock já vê 'ganho'.
      statusOverrideByOppId: { 55: 'ganho' },
    });
    const result = await runAutoLossSweep(pool);
    assert.deepEqual(result, { closed: 0 });
    assert.equal(store.get(55).status, 'ganho', 'a venda NÃO foi clobberada pra perdido');
    assert.equal(clientCalls.some((c) => /UPDATE whatsapp_opportunities SET/.test(c.text)), false,
      'guard barra ANTES do UPDATE — nenhuma escrita quando a premissa já não vale');
    assert.equal(clientCalls.some((c) => /INSERT INTO whatsapp_opportunity_events/.test(c.text)), false);
    assert.equal(infoCalls.length, 1, 'conflict loga info, não warn/error (guard funcionando, não é bug)');
    assert.match(String(infoCalls[0]![0]), /55/);
  } finally {
    console.info = originalInfo;
  }
});

test('runAutoLossSweep: guard (b) — mensagem nova chegou depois do SELECT de candidatos (re-check acha not-stale) → conflict, SEM UPDATE', async () => {
  const originalInfo = console.info;
  console.info = () => {}; // guard (a) já cobre o log de conflict; aqui só o comportamento
  try {
    const { pool, clientCalls, store } = fakePoolFull({
      settingsRows: [{ workspace_id: 'ws-1', auto_loss_days: 7 }],
      candidatesByWorkspace: { 'ws-1': [{ id: 56, whatsapp_number_id: 9, identifier: 'c', last_direction: 'inbound' }] },
      // simula: a leitura fresca (dentro do lock) do MAX(messages.created_at) já
      // não bate mais o corte de auto_loss_days — uma mensagem nova chegou.
      stillStaleByOppId: { 56: false },
    });
    const result = await runAutoLossSweep(pool);
    assert.deepEqual(result, { closed: 0 });
    assert.equal(store.get(56).status, 'em_andamento', 'não fechou — a conversa reativou');
    assert.equal(clientCalls.some((c) => /UPDATE whatsapp_opportunities SET/.test(c.text)), false);
  } finally {
    console.info = originalInfo;
  }
});

test('runAutoLossSweep: guard passa (status em_andamento + ainda stale) → fecha normalmente (não regride o caminho feliz)', async () => {
  const { pool, store, clientCalls } = fakePoolFull({
    settingsRows: [{ workspace_id: 'ws-1', auto_loss_days: 7 }],
    candidatesByWorkspace: { 'ws-1': [{ id: 57, whatsapp_number_id: 9, identifier: 'c', last_direction: 'inbound' }] },
  });
  const result = await runAutoLossSweep(pool);
  assert.deepEqual(result, { closed: 1 });
  assert.equal(store.get(57).status, 'perdido');
  const stillStaleCall = clientCalls.find((c) => /AS still_stale/.test(c.text));
  assert.ok(stillStaleCall, 'o guard deve rodar o re-check de inatividade sob o lock');
  assert.deepEqual(stillStaleCall!.params.slice(0, 2), [9, 'c']);
});

test('runAutoLossSweep: patch com {ok:false} (opp sumiu antes do patch) → loga warn e segue, sem incrementar closed', async () => {
  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnCalls.push(args); };
  try {
    const { pool } = fakePoolFull({
      settingsRows: [{ workspace_id: 'ws-1', auto_loss_days: 7 }],
      candidatesByWorkspace: { 'ws-1': [{ id: 99, whatsapp_number_id: 9, identifier: 'c', last_direction: 'inbound' }] },
      missingOppIds: new Set([99]),
    });
    const result = await runAutoLossSweep(pool);
    assert.deepEqual(result, { closed: 0 });
    assert.equal(warnCalls.length, 1);
    assert.match(String(warnCalls[0]![0]), /99/);
  } finally {
    console.warn = originalWarn;
  }
});

test('runAutoLossSweep: erro num workspace (query de candidatos falha) loga warn e segue pros demais (best-effort)', async () => {
  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnCalls.push(args); };
  try {
    const { pool } = fakePoolFull({
      settingsRows: [
        { workspace_id: 'ws-bad', auto_loss_days: 7 },
        { workspace_id: 'ws-ok', auto_loss_days: 7 },
      ],
      candidatesByWorkspace: {},
      failWorkspaces: new Set(['ws-bad']),
    });
    const result = await runAutoLossSweep(pool);
    assert.deepEqual(result, { closed: 0 });
    assert.equal(warnCalls.length, 1, 'workspace ok deve seguir sem gerar warn');
    assert.match(String(warnCalls[0]![0]), /ws-bad/);
  } finally {
    console.warn = originalWarn;
  }
});

// =============================================================================
// resolveAutoLossPollIntervalMs — explicit > env > default (1h)
// =============================================================================

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.CRM_AUTOLOSS_POLL_MS;
  if (value === undefined) delete process.env.CRM_AUTOLOSS_POLL_MS;
  else process.env.CRM_AUTOLOSS_POLL_MS = value;
  try { fn(); }
  finally {
    if (prev === undefined) delete process.env.CRM_AUTOLOSS_POLL_MS;
    else process.env.CRM_AUTOLOSS_POLL_MS = prev;
  }
}

test('resolveAutoLossPollIntervalMs: param explicit sempre vence, mesmo com env setada', () => {
  withEnv('999', () => {
    assert.equal(resolveAutoLossPollIntervalMs(1234), 1234);
  });
});

test('resolveAutoLossPollIntervalMs: sem explicit, lê CRM_AUTOLOSS_POLL_MS válida', () => {
  withEnv('120000', () => {
    assert.equal(resolveAutoLossPollIntervalMs(), 120_000);
  });
});

test('resolveAutoLossPollIntervalMs: env ausente ou inválida (não-numérica/<=0) → default 1h', () => {
  withEnv(undefined, () => {
    assert.equal(resolveAutoLossPollIntervalMs(), 60 * 60_000);
  });
  withEnv('lixo', () => {
    assert.equal(resolveAutoLossPollIntervalMs(), 60 * 60_000);
  });
  withEnv('0', () => {
    assert.equal(resolveAutoLossPollIntervalMs(), 60 * 60_000);
  });
  withEnv('-100', () => {
    assert.equal(resolveAutoLossPollIntervalMs(), 60 * 60_000);
  });
});

// =============================================================================
// startAutoLossPoller — flag in-flight (2 ticks simultâneos → 1 sweep)
// =============================================================================

test('startAutoLossPoller: 2 ticks simultâneos → só 1 sweep roda por vez (flag in-flight)', async () => {
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
    startAutoLossPoller(pool, 1000);
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
