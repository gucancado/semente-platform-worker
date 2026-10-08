import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processCollectedMeeting, importCollectedMeeting, type MeetingsCollectDeps } from '../../src/meetings-collect/service.js';

// Conta OpenAI fora = transcrição ao vivo da Vexa fora. Até 02/10/2026 o
// timeout de "sala muda" derrubava o bot com a reunião acontecendo. Pool falso
// (molde de admission-anchor.test.ts).

type Call = { sql: string; params: unknown[] };
function fakePool() {
  const calls: Call[] = [];
  return { calls, pool: { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: [] }; } } };
}
const NOW = new Date('2026-10-02T13:30:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', meet_code: 'ekt-trvt-tpv', vexa_meeting_id: 281, workspace_id: 'ws', status: 'collecting',
  failure_reason: null, requested_by: 'u', last_segment_at: null, episode_id: null, title: 'Estratégia',
  queue_expires_at: null, started_at: minutesAgo(25), created_at: minutesAgo(25), updated_at: minutesAgo(1),
  vexa_status: 'active', status_log: [], ...over,
}) as any;

function deps(pool: unknown, o: {
  health?: { state: 'ok' | 'down' | 'unknown'; lastDownAt: Date | null };
  segments?: Array<{ start: number; end: number; text: string; speaker: string }>;
  status?: string;
  stops: string[]; enq: string[];
}): MeetingsCollectDeps {
  return {
    pool: pool as any,
    vexa: {
      sendBot: async () => { throw new Error('não'); },
      getTranscript: async (code: string) => ({
        id: 281, platform: 'google_meet', native_meeting_id: code, status: o.status ?? 'active',
        start_time: null, end_time: null, segments: o.segments ?? [],
      }) as any,
      stopBot: async (code: string) => { o.stops.push(code); },
    },
    putAndVerify: async () => {},
    insertEpisode: (async () => ({ id: 77, duplicate: false, revision: 1 })) as any,
    inactivityStopMin: 10, admissionTimeoutMin: 20, botName: 'b', maxConcurrent: 2, queueMaxWaitMin: 120,
    now: () => NOW,
    ...(o.health ? { sttHealth: async () => o.health! } : {}),
    sttDownMaxMin: 180,
    enqueueRecovery: async (r, reason) => { o.enq.push(`${r.id}:${reason}`); },
  };
}

test('conta fora: zero segmento além do timeout NÃO derruba o bot', async () => {
  const { pool, calls } = fakePool();
  const stops: string[] = []; const enq: string[] = [];
  await processCollectedMeeting(deps(pool, { health: { state: 'down', lastDownAt: NOW }, stops, enq }), row());
  assert.deepEqual(stops, []);
  assert.equal(calls.some((c) => c.params.includes('silent_room')), false);
  assert.deepEqual(enq, []);
});

test('conta ok: comportamento antigo — silent_room + encaminha para a gravação', async () => {
  const { pool, calls } = fakePool();
  const stops: string[] = []; const enq: string[] = [];
  await processCollectedMeeting(deps(pool, { health: { state: 'ok', lastDownAt: null }, stops, enq }), row());
  assert.deepEqual(stops, ['ekt-trvt-tpv']);
  assert.ok(calls.some((c) => c.params.includes('silent_room')));
  assert.deepEqual(enq, ['r1:silent_room']);
});

test('conta fora além do teto (180 min): sai e encaminha', async () => {
  const { pool } = fakePool();
  const stops: string[] = []; const enq: string[] = [];
  await processCollectedMeeting(
    deps(pool, { health: { state: 'down', lastDownAt: NOW }, stops, enq }),
    row({ started_at: minutesAgo(200), created_at: minutesAgo(200) }),
  );
  assert.deepEqual(stops, ['ekt-trvt-tpv']);
  assert.deepEqual(enq, ['r1:silent_room']);
});

test('queda NO MEIO da reunião (segmentos pararam): não sai por inatividade', async () => {
  const { pool } = fakePool();
  const stops: string[] = []; const enq: string[] = [];
  const last = minutesAgo(15).getTime() / 1000;
  await processCollectedMeeting(
    deps(pool, { health: { state: 'ok', lastDownAt: minutesAgo(12) }, stops, enq,
      segments: [{ start: last - 5, end: last, text: 'oi', speaker: 'Ana' }] }),
    row(),
  );
  assert.deepEqual(stops, []);
});

test('sem sttHealth (deps antigas): sai por silêncio como antes', async () => {
  const { pool } = fakePool();
  const stops: string[] = []; const enq: string[] = [];
  await processCollectedMeeting(deps(pool, { stops, enq }), row());
  assert.deepEqual(stops, ['ekt-trvt-tpv']);
});

test('importação com queda durante a reunião → recuperação parcial', async () => {
  const { pool } = fakePool();
  const stops: string[] = []; const enq: string[] = [];
  const t = NOW.getTime() / 1000 - 600;
  const segs = Array.from({ length: 5 }, (_, i) => ({ start: t + i * 10, end: t + i * 10 + 8, text: `fala ${i}`, speaker: 'Ana' }));
  await importCollectedMeeting(
    deps(pool, { health: { state: 'ok', lastDownAt: minutesAgo(5) }, stops, enq }),
    row(),
    { id: 281, platform: 'google_meet', native_meeting_id: 'ekt-trvt-tpv', status: 'completed', start_time: null, end_time: null, segments: segs } as any,
  );
  assert.deepEqual(enq, ['r1:partial']);
});

test('importação sem queda → não encaminha', async () => {
  const { pool } = fakePool();
  const stops: string[] = []; const enq: string[] = [];
  const t = NOW.getTime() / 1000 - 600;
  const segs = Array.from({ length: 5 }, (_, i) => ({ start: t + i * 10, end: t + i * 10 + 8, text: `fala ${i}`, speaker: 'Ana' }));
  await importCollectedMeeting(
    deps(pool, { health: { state: 'ok', lastDownAt: minutesAgo(60) }, stops, enq }),
    row(),
    { id: 281, platform: 'google_meet', native_meeting_id: 'ekt-trvt-tpv', status: 'completed', start_time: null, end_time: null, segments: segs } as any,
  );
  assert.deepEqual(enq, []);
});
