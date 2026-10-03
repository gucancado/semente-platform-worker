import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendStatusLog, vexaFailedDetail, silentRoomDetail, truncateDetail, STATUS_LOG_CAP, FAILURE_DETAIL_MAX,
} from '../../src/meetings-collect/diagnostics.js';
import { planCollectReuse } from '../../src/meetings-collect/reuse.js';
import {
  processCollectedMeeting, promoteQueuedMeetings, type MeetingsCollectDeps,
} from '../../src/meetings-collect/service.js';

// Diagnóstico das coletas (mig 069) e reaproveitamento de pedido duplicado.
// Sem Postgres: as funções puras direto, e o poller com pool falso que registra
// as queries (mesmo molde de admission-anchor.test.ts).

// ── status_log ──────────────────────────────────────────────────────────────
const e = (i: number) => ({ at: `2026-10-03T12:${String(i % 60).padStart(2, '0')}:00Z`, status: `s${i}`, segments: i });

test('appendStatusLog: anexa ao fim', () => {
  assert.deepEqual(appendStatusLog([e(1)], e(2)), [e(1), e(2)]);
});

test('appendStatusLog: teto mantém as MAIS RECENTES', () => {
  const log = Array.from({ length: STATUS_LOG_CAP }, (_, i) => e(i));
  const out = appendStatusLog(log, e(999));
  assert.equal(out.length, STATUS_LOG_CAP);
  assert.deepEqual(out[out.length - 1], e(999));
  assert.deepEqual(out[0], e(1), 'a mais antiga saiu');
});

test('appendStatusLog: lixo do banco recomeça a trilha', () => {
  assert.deepEqual(appendStatusLog(null, e(1)), [e(1)]);
  assert.deepEqual(appendStatusLog({ x: 1 }, e(1)), [e(1)]);
});

// ── failure_detail ──────────────────────────────────────────────────────────
test('vexaFailedDetail: status + motivos de data + última transição', () => {
  const d = vexaFailedDetail({
    status: 'failed',
    data: {
      failure_stage: 'joining', error_details: 'meeting not found',
      status_transition: [
        { from: null, to: 'joining', timestamp: 't1', source: 'bot_callback' },
        { from: 'joining', to: 'failed', timestamp: 't2', source: 'bot_callback', reason: 'timeout' },
      ],
    },
  });
  assert.match(d, /^status=failed/);
  assert.match(d, /failure_stage=joining/);
  assert.match(d, /error_details=meeting not found/);
  assert.match(d, /ultima_transicao=joining→failed \(reason=timeout\)/);
});

test('vexaFailedDetail: sem campo reconhecido guarda o data cru, truncado em 500', () => {
  const d = vexaFailedDetail({ status: 'failed', data: { esquisito: 'x'.repeat(2000) } });
  assert.match(d, /data=\{"esquisito"/);
  assert.equal(d.length, FAILURE_DETAIL_MAX);
});

test('vexaFailedDetail: sem data, só o status', () => {
  assert.equal(vexaFailedDetail({ status: 'failed' }), 'status=failed');
});

test('silentRoomDetail distingue sala de espera e diz quanto esperou', () => {
  assert.equal(silentRoomDetail('awaiting_admission', 1_200_400), 'ultimo_status_vexa=awaiting_admission; 1200s sem fala');
  assert.match(silentRoomDetail(null, 0), /desconhecido/);
});

test('truncateDetail', () => {
  assert.equal(truncateDetail('abc', 10), 'abc');
  assert.equal(truncateDetail('abcdefghijk', 5), 'abcd…');
});

// ── reaproveitamento de pedido duplicado ────────────────────────────────────
const NOW = new Date('2026-10-02T17:00:00Z');
const at = (m: number) => new Date(NOW.getTime() + m * 60_000);
const existing = (over: Record<string, unknown> = {}) => ({
  status: 'queued', queue_expires_at: null, created_at: at(-8), started_at: null, title: null, workspace_id: null,
  ...over,
}) as any;

test('planCollectReuse: estende a expiração só quando a nova é maior', () => {
  const inc = (q: Date | null) => ({ workspaceId: null, title: null, queueExpiresAt: q });
  assert.deepEqual(planCollectReuse(existing({ queue_expires_at: at(30) }), inc(at(60)), NOW, 120).queueExpiresAt, at(60));
  assert.equal(planCollectReuse(existing({ queue_expires_at: at(30) }), inc(at(10)), NOW, 120).queueExpiresAt, undefined);
  // sem queue_expires_at o limite efetivo é created_at + max wait (−8 + 120 = 112)
  assert.equal(planCollectReuse(existing(), inc(at(100)), NOW, 120).queueExpiresAt, undefined);
  assert.deepEqual(planCollectReuse(existing(), inc(at(130)), NOW, 120).queueExpiresAt, at(130));
});

test('planCollectReuse: collecting move a âncora de admissão pra agora (nunca recua)', () => {
  const inc = { workspaceId: null, title: null, queueExpiresAt: null };
  assert.deepEqual(planCollectReuse(existing({ status: 'collecting', started_at: at(-8) }), inc, NOW, 120).startedAt, NOW);
  assert.deepEqual(planCollectReuse(existing({ status: 'collecting', started_at: null }), inc, NOW, 120).startedAt, NOW);
  assert.equal(planCollectReuse(existing({ status: 'collecting', started_at: at(5) }), inc, NOW, 120).startedAt, undefined);
  assert.equal(planCollectReuse(existing({ status: 'queued' }), inc, NOW, 120).startedAt, undefined, 'queued não tem âncora');
});

test('planCollectReuse: título/workspace só preenchem o que está vazio', () => {
  const inc = { workspaceId: 'ws-b', title: 'Nova', queueExpiresAt: null };
  assert.deepEqual(planCollectReuse(existing(), inc, NOW, 120), { title: 'Nova', workspaceId: 'ws-b' });
  assert.deepEqual(planCollectReuse(existing({ title: 'Velha', workspace_id: 'ws-a' }), inc, NOW, 120), {});
});

// ── instrumentação no poller (pool falso, sem Postgres) ─────────────────────
type Call = { sql: string; params: unknown[] };
function fakePool() {
  const calls: Call[] = [];
  return {
    calls,
    pool: { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: [{ n: '0' }] }; } },
  };
}
const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', meet_code: 'abc-defg-hij', vexa_meeting_id: null, workspace_id: 'ws', status: 'collecting',
  failure_reason: null, requested_by: 'u', last_segment_at: null, episode_id: null, title: null,
  queue_expires_at: null, started_at: at(-30), created_at: at(-30), updated_at: at(-1),
  vexa_status: null, vexa_status_at: null, failure_detail: null, status_log: [],
  ...over,
}) as any;
function deps(pool: unknown, meeting: Record<string, unknown>, infos: unknown[] = []): MeetingsCollectDeps {
  return {
    pool: pool as any,
    vexa: {
      sendBot: async () => { throw new Error('vexa: HTTP 409 — bot already exists for this meeting'); },
      getTranscript: async () => ({ id: 77, platform: 'google_meet', native_meeting_id: 'abc-defg-hij', start_time: null, end_time: null, segments: [], ...meeting }) as any,
      stopBot: async () => {},
    },
    putAndVerify: async () => {}, insertEpisode: (async () => { throw new Error('não importa'); }) as any,
    inactivityStopMin: 10, admissionTimeoutMin: 20, botName: 'b', maxConcurrent: 2, queueMaxWaitMin: 120,
    now: () => NOW,
    log: { warn: () => {}, info: (o: unknown) => { infos.push(o); } },
  };
}
const updates = (calls: Call[]) => calls.filter((c) => /UPDATE collected_meetings/.test(c.sql));

test('poller: status mudou → grava vexa_status, anexa status_log e loga', async () => {
  const { pool, calls } = fakePool();
  const infos: unknown[] = [];
  await processCollectedMeeting(deps(pool, { status: 'awaiting_admission' }, infos), row({ started_at: at(-1) }));
  const first = updates(calls)[0]!;
  assert.match(first.sql, /vexa_status = /);
  assert.match(first.sql, /status_log = /);
  assert.ok(first.params.includes('awaiting_admission'));
  const log = JSON.parse(first.params.find((p) => typeof p === 'string' && p.startsWith('[')) as string);
  assert.deepEqual(log, [{ at: NOW.toISOString(), status: 'awaiting_admission', segments: 0 }]);
  assert.equal(infos.length, 1);
});

test('poller: status igual → grava vexa_status_at mas não mexe na trilha', async () => {
  const { pool, calls } = fakePool();
  const infos: unknown[] = [];
  await processCollectedMeeting(deps(pool, { status: 'active' }, infos), row({ vexa_status: 'active', started_at: at(-1) }));
  const first = updates(calls)[0]!;
  assert.match(first.sql, /vexa_status_at = /);
  assert.doesNotMatch(first.sql, /status_log/);
  assert.equal(infos.length, 0);
});

test('poller: vexa_failed grava failure_detail com o motivo do Vexa', async () => {
  const { pool, calls } = fakePool();
  await processCollectedMeeting(deps(pool, { status: 'failed', data: { failure_stage: 'joining' } }), row());
  const fail = updates(calls).find((c) => c.params.includes('vexa_failed'))!;
  assert.ok(fail.params.some((p) => typeof p === 'string' && p.includes('failure_stage=joining')));
});

test('poller: silent_room grava último status + segundos esperados', async () => {
  const { pool, calls } = fakePool();
  await processCollectedMeeting(deps(pool, { status: 'awaiting_admission' }), row({ started_at: at(-21) }));
  const fail = updates(calls).find((c) => c.params.includes('silent_room'))!;
  assert.ok(fail.params.includes('ultimo_status_vexa=awaiting_admission; 1260s sem fala'));
});

test('promoção: vexa_send_failed grava a mensagem do erro (HTTP + corpo)', async () => {
  const calls: Call[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/count\(\*\)/i.test(sql)) return { rows: [{ n: '0' }] };
      if (/status = 'queued'/.test(sql)) return { rows: [row({ status: 'queued', created_at: at(-1) })] };
      return { rows: [] };
    },
  };
  await promoteQueuedMeetings(deps(pool, {}));
  const fail = calls.find((c) => c.params.includes('vexa_send_failed'))!;
  assert.ok(fail.params.includes('vexa: HTTP 409 — bot already exists for this meeting'));
});
