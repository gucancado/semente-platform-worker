import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { createCollectedMeeting, getCollectedMeeting, updateCollectedMeeting } from '../../src/meetings-collect/db.js';
import { insertEpisodeWithTurns } from '../../src/episodes/db.js';
import { runMeetingsCollectBatch, type MeetingsCollectDeps } from '../../src/meetings-collect/poller.js';

const R2_CALLS: any[] = [];
function baseDeps(vexaMeetingByCode: Record<string, any>, now: Date, opts: { sendBotCalls?: string[] } = {}): MeetingsCollectDeps {
  return {
    pool,
    vexa: {
      sendBot: async (code: string) => { opts.sendBotCalls?.push(code); return { id: 900, native_meeting_id: code, status: 'joining', start_time: null, end_time: null, segments: [] } as any; },
      getTranscript: async (code: string) => vexaMeetingByCode[code],
      stopBot: async () => {},
    },
    putAndVerify: async (key: string) => { R2_CALLS.push(key); },
    insertEpisode: insertEpisodeWithTurns,
    inactivityStopMin: 10,
    admissionTimeoutMin: 10,
    botName: 'BeeAds Notetaker',
    maxConcurrent: 1,
    queueMaxWaitMin: 120,
    now: () => now,
  };
}

beforeEach(async () => {
  R2_CALLS.length = 0;
  await pool.query('TRUNCATE collected_meetings, episode_turns, episodes RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('tick promove queued (sendBot) ANTES de processar as ativas', async () => {
  const row = await createCollectedMeeting(pool, { meetCode: 'abc-defg-hij', workspaceId: null, requestedBy: 'u' });
  assert.equal(row.status, 'queued');
  const now = new Date('2026-07-13T15:00:00Z');
  const nowS = now.getTime() / 1000;
  const meeting = {
    id: 601, native_meeting_id: 'abc-defg-hij', status: 'active',
    start_time: '2026-07-13T14:00:00.000000', end_time: null,
    segments: [{ start: nowS - 60, end: nowS - 5, text: 'oi', language: null, speaker: 'Ana' }],
  };
  const sendBotCalls: string[] = [];
  const n = await runMeetingsCollectBatch(baseDeps({ 'abc-defg-hij': meeting }, now, { sendBotCalls }));
  assert.deepEqual(sendBotCalls, ['abc-defg-hij']); // promovido neste tick
  assert.equal(n, 1); // após promoção, 1 ativa foi processada
  const r = await getCollectedMeeting(pool, row.id);
  assert.equal(r!.status, 'collecting');
  assert.ok(r!.last_segment_at); // processCollectedMeeting rodou DEPOIS da promoção
});

test('meeting completed → import: R2 antes, episódio criado, status=imported', async () => {
  const row = await createCollectedMeeting(pool, { meetCode: 'abc-defg-hij', workspaceId: 'ws-1', requestedBy: 'u' });
  const now = new Date('2026-07-13T15:00:00Z');
  const meeting = {
    id: 501, native_meeting_id: 'abc-defg-hij', status: 'completed',
    start_time: '2026-07-13T14:00:00.000000', end_time: '2026-07-13T14:10:00.000000',
    segments: [{ start: 1000, end: 1002, text: 'oi', language: null, speaker: 'Ana' }],
  };
  const n = await runMeetingsCollectBatch(baseDeps({ 'abc-defg-hij': meeting }, now));
  assert.equal(n, 1);
  assert.deepEqual(R2_CALLS, ['vexa/501.json']); // R2 primeiro, key correta
  const r = await getCollectedMeeting(pool, row.id);
  assert.equal(r!.status, 'imported');
  assert.ok(r!.episode_id);
  const ep = await pool.query('SELECT external_source, workspace_id, attribution_method FROM episodes WHERE id=$1', [r!.episode_id]);
  assert.equal(ep.rows[0].external_source, 'vexa');
  assert.equal(ep.rows[0].workspace_id, 'ws-1');
  assert.equal(ep.rows[0].attribution_method, 'manual');
});

test('inatividade > limite → stopBot + import', async () => {
  const row = await createCollectedMeeting(pool, { meetCode: 'abc-defg-hij', workspaceId: null, requestedBy: 'u' });
  const now = new Date('2026-07-13T15:00:00Z');
  const nowS = now.getTime() / 1000;
  const meeting = {
    id: 502, native_meeting_id: 'abc-defg-hij', status: 'active',
    start_time: '2026-07-13T14:00:00.000000', end_time: null,
    // último segment 15 min antes de `now` (epoch s) → idle 15min > 10min → import
    segments: [{ start: nowS - 16 * 60, end: nowS - 15 * 60, text: 'oi', language: null, speaker: 'Ana' }],
  };
  await runMeetingsCollectBatch(baseDeps({ 'abc-defg-hij': meeting }, now));
  const r = await getCollectedMeeting(pool, row.id);
  assert.equal(r!.status, 'imported');
});

test('zero segments + admissão estourada → failed/not_admitted', async () => {
  const row = await createCollectedMeeting(pool, { meetCode: 'abc-defg-hij', workspaceId: null, requestedBy: 'u' });
  // created_at ~agora; força now 20 min à frente
  const now = new Date(Date.now() + 20 * 60_000);
  const meeting = { id: 503, native_meeting_id: 'abc-defg-hij', status: 'awaiting_admission', start_time: null, end_time: null, segments: [] };
  await runMeetingsCollectBatch(baseDeps({ 'abc-defg-hij': meeting }, now));
  const r = await getCollectedMeeting(pool, row.id);
  assert.equal(r!.status, 'failed');
  assert.equal(r!.failure_reason, 'not_admitted');
});

test('ainda ativa, com segments recentes → segue coletando', async () => {
  const row = await createCollectedMeeting(pool, { meetCode: 'abc-defg-hij', workspaceId: null, requestedBy: 'u' });
  const now = new Date('2026-07-13T15:00:00Z');
  const nowS = now.getTime() / 1000;
  const meeting = {
    id: 504, native_meeting_id: 'abc-defg-hij', status: 'active',
    start_time: '2026-07-13T14:00:00.000000', end_time: null,
    // último segment 5s antes de `now` (epoch s) → idle 5s < 10min → segue coletando
    segments: [{ start: nowS - 60, end: nowS - 5, text: 'oi', language: null, speaker: 'Ana' }],
  };
  await runMeetingsCollectBatch(baseDeps({ 'abc-defg-hij': meeting }, now));
  const r = await getCollectedMeeting(pool, row.id);
  assert.equal(r!.status, 'collecting');
  assert.ok(r!.last_segment_at);
});

test('import é idempotente (rodar 2x não duplica episódio)', async () => {
  const row = await createCollectedMeeting(pool, { meetCode: 'abc-defg-hij', workspaceId: 'ws-1', requestedBy: 'u' });
  const now = new Date('2026-07-13T15:00:00Z');
  const meeting = { id: 505, native_meeting_id: 'abc-defg-hij', status: 'completed', start_time: '2026-07-13T14:00:00.000000', end_time: '2026-07-13T14:05:00.000000', segments: [{ start: 1, end: 2, text: 'a', language: null, speaker: 'Ana' }] };
  await runMeetingsCollectBatch(baseDeps({ 'abc-defg-hij': meeting }, now));
  // re-marca collecting e roda de novo → dedup por (external_source, external_id)
  await updateCollectedMeeting(pool, row.id, { status: 'collecting' });
  await runMeetingsCollectBatch(baseDeps({ 'abc-defg-hij': meeting }, now));
  const cnt = await pool.query("SELECT COUNT(*)::int c FROM episodes WHERE external_source='vexa' AND external_id='505'");
  assert.equal(cnt.rows[0].c, 1);
});
