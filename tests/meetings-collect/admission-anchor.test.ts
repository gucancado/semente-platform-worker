import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  processCollectedMeeting, promoteQueuedMeetings, type MeetingsCollectDeps,
} from '../../src/meetings-collect/service.js';

// O timeout de admissão (zero fala por N min → silent_room) media desde
// `created_at`, que desde a fila (mig 048) é o instante do PEDIDO. Uma coleta
// que esperou vaga na fila era promovida e, no mesmo tick do poller, morria como
// silent_room antes de o bot entrar. A âncora certa é `started_at`: o instante em
// que a promoção mandou o bot. Sem Postgres local — pool falso que registra as
// queries; os .db.test.ts cobrem o caminho com banco.

type Call = { sql: string; params: unknown[] };

function fakePool(opts: { queued?: Record<string, unknown>[]; active?: number } = {}) {
  const calls: Call[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/count\(\*\)/i.test(sql)) return { rows: [{ n: String(opts.active ?? 0) }] };
      if (/status = 'queued'/.test(sql)) return { rows: opts.queued ?? [] };
      return { rows: [] };
    },
  };
  return { pool, calls };
}

const NOW = new Date('2026-09-15T17:30:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function row(over: Record<string, unknown>) {
  return {
    id: 'r1', meet_code: 'abc-defg-hij', vexa_meeting_id: null, workspace_id: 'ws',
    status: 'collecting', failure_reason: null, requested_by: 'u', last_segment_at: null,
    episode_id: null, title: null, queue_expires_at: null, started_at: null,
    created_at: minutesAgo(1), updated_at: minutesAgo(1),
    ...over,
  } as any;
}

function deps(pool: unknown, stopCalls: string[]): MeetingsCollectDeps {
  return {
    pool: pool as any,
    vexa: {
      sendBot: async (code: string) =>
        ({ id: 900, platform: 'google_meet', native_meeting_id: code, status: 'joining', start_time: null, end_time: null, segments: [] }) as any,
      getTranscript: async (code: string) =>
        ({ id: 900, platform: 'google_meet', native_meeting_id: code, status: 'awaiting_admission', start_time: null, end_time: null, segments: [] }) as any,
      stopBot: async (code: string) => { stopCalls.push(code); },
    },
    putAndVerify: async () => {},
    insertEpisode: (async () => { throw new Error('não deve importar episódio'); }) as any,
    inactivityStopMin: 10,
    admissionTimeoutMin: 20,
    botName: 'BeeAds Notetaker',
    maxConcurrent: 2,
    queueMaxWaitMin: 120,
    now: () => NOW,
  };
}

const markedFailed = (calls: Call[]) => calls.some((c) => c.params.includes('failed'));

test('coleta que esperou na fila não morre no tick da promoção: admissão conta desde started_at', async () => {
  const { pool, calls } = fakePool();
  const stopCalls: string[] = [];
  // pedida há 45 min (fila), bot enviado há 1 min, ninguém falou ainda
  await processCollectedMeeting(deps(pool, stopCalls), row({ created_at: minutesAgo(45), started_at: minutesAgo(1) }));
  assert.equal(markedFailed(calls), false);
  assert.deepEqual(stopCalls, []);
});

test('started_at além do timeout → silent_room', async () => {
  const { pool, calls } = fakePool();
  const stopCalls: string[] = [];
  await processCollectedMeeting(deps(pool, stopCalls), row({ created_at: minutesAgo(60), started_at: minutesAgo(25) }));
  assert.equal(markedFailed(calls), true);
  assert.ok(calls.some((c) => c.params.includes('silent_room')));
  assert.deepEqual(stopCalls, ['abc-defg-hij']);
});

test('sem started_at (row anterior à mig 065) mantém o relógio de created_at', async () => {
  const { pool, calls } = fakePool();
  const stopCalls: string[] = [];
  await processCollectedMeeting(deps(pool, stopCalls), row({ created_at: minutesAgo(25), started_at: null }));
  assert.ok(calls.some((c) => c.params.includes('silent_room')));
});

test('promoção grava started_at com o relógio do worker (o mesmo do timeout)', async () => {
  const queued = row({ status: 'queued', created_at: minutesAgo(45) });
  const { pool, calls } = fakePool({ queued: [queued], active: 0 });
  await promoteQueuedMeetings(deps(pool, []));
  const promotion = calls.find((c) => /^UPDATE/.test(c.sql) && c.params.includes('collecting'));
  assert.ok(promotion, 'a promoção deve marcar collecting');
  assert.match(promotion!.sql, /started_at/);
  assert.ok(promotion!.params.some((p) => p instanceof Date && p.getTime() === NOW.getTime()));
});
