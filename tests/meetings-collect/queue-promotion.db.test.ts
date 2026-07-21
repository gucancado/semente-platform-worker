import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { createCollectedMeeting, getCollectedMeeting, updateCollectedMeeting } from '../../src/meetings-collect/db.js';
import { insertEpisodeWithTurns } from '../../src/episodes/db.js';
import { promoteQueuedMeetings, type MeetingsCollectDeps } from '../../src/meetings-collect/service.js';

// Fila de slots: promoteQueuedMeetings expira as velhas e sobe as mais antigas
// enquanto houver slot. Usa vexa fake que registra cada sendBot num array.
function fakeMeeting(id: number, code: string) {
  return { id, platform: 'google_meet', native_meeting_id: code, status: 'joining', start_time: null, end_time: null, segments: [] };
}

function buildDeps(opts: {
  sendBotCalls: Array<{ code: string; name: string; lang: string }>;
  sendBot?: (code: string) => Promise<any>;
  now: Date;
  maxConcurrent?: number;
  queueMaxWaitMin?: number;
}): MeetingsCollectDeps {
  return {
    pool,
    vexa: {
      sendBot: async (code: string, name: string, lang: string) => {
        opts.sendBotCalls.push({ code, name, lang });
        return opts.sendBot ? opts.sendBot(code) : fakeMeeting(700, code);
      },
      getTranscript: async () => { throw new Error('getTranscript não deve ser chamado na promoção'); },
      stopBot: async () => {},
    },
    putAndVerify: async () => {},
    insertEpisode: insertEpisodeWithTurns,
    inactivityStopMin: 10,
    admissionTimeoutMin: 10,
    botName: 'BeeAds Notetaker',
    maxConcurrent: opts.maxConcurrent ?? 1,
    queueMaxWaitMin: opts.queueMaxWaitMin ?? 120,
    now: () => opts.now,
  };
}

beforeEach(async () => {
  await pool.query('TRUNCATE collected_meetings, facts, episode_turns, episodes RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('slot livre + 2 na fila (max 1): promove só a mais antiga', async () => {
  const a = await createCollectedMeeting(pool, { meetCode: 'aaa-bbbb-ccc', workspaceId: null, requestedBy: 'u' });
  const b = await createCollectedMeeting(pool, { meetCode: 'ddd-eeee-fff', workspaceId: null, requestedBy: 'u' });
  const calls: Array<{ code: string; name: string; lang: string }> = [];
  const res = await promoteQueuedMeetings(buildDeps({ sendBotCalls: calls, now: new Date() }));
  assert.deepEqual(res, { promoted: 1, expired: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.code, 'aaa-bbbb-ccc'); // FIFO: a mais antiga
  assert.equal(calls[0]!.name, 'BeeAds Notetaker');
  assert.equal(calls[0]!.lang, 'pt');
  assert.equal((await getCollectedMeeting(pool, a.id))!.status, 'collecting');
  assert.equal((await getCollectedMeeting(pool, b.id))!.status, 'queued'); // a outra segue na fila
});

test('slot ocupado (já há collecting): promove 0', async () => {
  const active = await createCollectedMeeting(pool, { meetCode: 'aaa-bbbb-ccc', workspaceId: null, requestedBy: 'u' });
  await updateCollectedMeeting(pool, active.id, { status: 'collecting' });
  const queued = await createCollectedMeeting(pool, { meetCode: 'ddd-eeee-fff', workspaceId: null, requestedBy: 'u' });
  const calls: Array<{ code: string; name: string; lang: string }> = [];
  const res = await promoteQueuedMeetings(buildDeps({ sendBotCalls: calls, now: new Date() }));
  assert.deepEqual(res, { promoted: 0, expired: 0 });
  assert.equal(calls.length, 0);
  assert.equal((await getCollectedMeeting(pool, queued.id))!.status, 'queued');
});

test('queued com queue_expires_at no passado: failed/no_slot e sendBot NÃO chamado', async () => {
  const past = new Date(Date.now() - 60_000);
  const row = await createCollectedMeeting(pool, { meetCode: 'aaa-bbbb-ccc', workspaceId: null, requestedBy: 'u', queueExpiresAt: past });
  const calls: Array<{ code: string; name: string; lang: string }> = [];
  const res = await promoteQueuedMeetings(buildDeps({ sendBotCalls: calls, now: new Date() }));
  assert.deepEqual(res, { promoted: 0, expired: 1 });
  assert.equal(calls.length, 0);
  const r = await getCollectedMeeting(pool, row.id);
  assert.equal(r!.status, 'failed');
  assert.equal(r!.failure_reason, 'no_slot');
});

test('queued sem expires e created_at velho (> queueMaxWaitMin, now injetado): failed/no_slot', async () => {
  const row = await createCollectedMeeting(pool, { meetCode: 'aaa-bbbb-ccc', workspaceId: null, requestedBy: 'u' });
  // now 130 min à frente do created_at (default queueMaxWaitMin=120) → expira
  const now = new Date(Date.now() + 130 * 60_000);
  const calls: Array<{ code: string; name: string; lang: string }> = [];
  const res = await promoteQueuedMeetings(buildDeps({ sendBotCalls: calls, now }));
  assert.deepEqual(res, { promoted: 0, expired: 1 });
  assert.equal(calls.length, 0);
  const r = await getCollectedMeeting(pool, row.id);
  assert.equal(r!.status, 'failed');
  assert.equal(r!.failure_reason, 'no_slot');
});

test('contrato nunca-lança: erro de DB na promoção é engolido (resolve, não rejeita)', async () => {
  // pool-stub que rejeita em TODA query → listQueuedMeetings lança dentro de promote.
  // Exercita o catch de erro de DB (não o de sendBot).
  const throwingPool = { query: async () => { throw new Error('db down'); } } as any;
  const warns: unknown[] = [];
  const calls: Array<{ code: string; name: string; lang: string }> = [];
  const deps = buildDeps({ sendBotCalls: calls, now: new Date() });
  deps.pool = throwingPool;
  deps.log = { warn: (o) => { warns.push(o); }, info: () => {} };
  // Deve RESOLVER (não rejeitar) mesmo com o DB fora.
  const res = await promoteQueuedMeetings(deps);
  assert.deepEqual(res, { promoted: 0, expired: 0 }); // nada acumulado (falhou na 1ª query)
  assert.equal(calls.length, 0); // sendBot nunca chamado
  assert.equal(warns.length, 1); // logou o erro de DB via deps.log.warn
});

test('sendBot lança na 1ª: failed/vexa_send_failed e a PRÓXIMA é promovida no mesmo tick', async () => {
  const a = await createCollectedMeeting(pool, { meetCode: 'aaa-bbbb-ccc', workspaceId: null, requestedBy: 'u' });
  const b = await createCollectedMeeting(pool, { meetCode: 'ddd-eeee-fff', workspaceId: null, requestedBy: 'u' });
  const calls: Array<{ code: string; name: string; lang: string }> = [];
  const deps = buildDeps({
    sendBotCalls: calls,
    sendBot: async (code: string) => {
      if (code === 'aaa-bbbb-ccc') throw new Error('boom');
      return fakeMeeting(777, code);
    },
    now: new Date(),
  });
  const res = await promoteQueuedMeetings(deps);
  assert.deepEqual(res, { promoted: 1, expired: 0 });
  assert.equal(calls.length, 2); // tentou as duas no mesmo tick
  const ra = await getCollectedMeeting(pool, a.id);
  const rb = await getCollectedMeeting(pool, b.id);
  assert.equal(ra!.status, 'failed');
  assert.equal(ra!.failure_reason, 'vexa_send_failed');
  assert.equal(rb!.status, 'collecting'); // a próxima subiu
});
