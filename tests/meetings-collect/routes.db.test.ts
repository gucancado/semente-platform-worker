import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { insertEpisodeWithTurns } from '../../src/episodes/db.js';
import { registerMeetingsCollectRoutes } from '../../src/meetings-collect/routes.js';
import { getCollectedMeeting, createCollectedMeeting, updateCollectedMeeting } from '../../src/meetings-collect/db.js';

const PANEL = 'tok-test';
function buildApp(vexaOverrides: any = {}) {
  const app = Fastify();
  const vexa = {
    sendBot: async () => ({ id: 900, native_meeting_id: 'abc-defg-hij', status: 'joining', start_time: null, end_time: null, segments: [] }),
    getTranscript: async () => ({ id: 900, native_meeting_id: 'abc-defg-hij', status: 'active', start_time: null, end_time: null, segments: [] }),
    stopBot: async () => {},
    ...vexaOverrides,
  };
  const collectDeps = {
    pool, vexa, putAndVerify: async () => {}, insertEpisode: insertEpisodeWithTurns,
    inactivityStopMin: 10, admissionTimeoutMin: 10, botName: 'BeeAds Notetaker',
    maxConcurrent: 1, queueMaxWaitMin: 120, now: () => new Date(),
  };
  registerMeetingsCollectRoutes(app, { pool, panelToken: PANEL, collectDeps: collectDeps as any });
  return app;
}
const H = { 'x-panel-token': PANEL, 'x-acting-user': 'u1', 'content-type': 'application/json' };

beforeEach(async () => { await pool.query('TRUNCATE collected_meetings, facts, episode_turns, episodes RESTART IDENTITY CASCADE'); });
after(() => pool.end());

test('POST sem panel token → 401', async () => {
  const app = buildApp();
  const r = await app.inject({ method: 'POST', url: '/meetings-collect', payload: { meetCode: 'abc-defg-hij' } });
  assert.equal(r.statusCode, 401);
});

test('POST cria coleta collecting', async () => {
  const app = buildApp();
  const r = await app.inject({ method: 'POST', url: '/meetings-collect', headers: H, payload: { meetCode: 'abc-defg-hij', workspaceId: 'ws-1' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'collecting');
});

test('POST com coleta ativa → 200 status queued (entra na fila, sem 409)', async () => {
  const app = buildApp();
  // já há uma coleta ocupando o único slot
  const active = await createCollectedMeeting(pool, { meetCode: 'aaa-bbbb-ccc', workspaceId: null, requestedBy: 'x' });
  await updateCollectedMeeting(pool, active.id, { status: 'collecting' });
  const r = await app.inject({ method: 'POST', url: '/meetings-collect', headers: H, payload: { meetCode: 'abc-defg-hij' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'queued');
  assert.equal(r.json().meet_code, 'abc-defg-hij');
});

test('POST com slot livre → 200 status collecting e sendBot chamado com o meetCode', async () => {
  const sendBotCalls: string[] = [];
  const app = buildApp({ sendBot: async (code: string) => { sendBotCalls.push(code); return { id: 901, native_meeting_id: code, status: 'joining', start_time: null, end_time: null, segments: [] }; } });
  const r = await app.inject({ method: 'POST', url: '/meetings-collect', headers: H, payload: { meetCode: 'abc-defg-hij' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'collecting');
  assert.deepEqual(sendBotCalls, ['abc-defg-hij']); // a promoção é o único caminho que sobe bot
});

test('POST com expiresAt inválido → 400 invalid_expires_at', async () => {
  const app = buildApp();
  const r = await app.inject({ method: 'POST', url: '/meetings-collect', headers: H, payload: { meetCode: 'abc-defg-hij', expiresAt: 'not-a-date' } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'invalid_expires_at');
});

test('POST com title → row persiste o title', async () => {
  const app = buildApp();
  const r = await app.inject({ method: 'POST', url: '/meetings-collect', headers: H, payload: { meetCode: 'abc-defg-hij', title: 'Hoenka + BeeAds' } });
  assert.equal(r.statusCode, 200);
  const row = await getCollectedMeeting(pool, r.json().id);
  assert.equal(row!.title, 'Hoenka + BeeAds');
});

test('PATCH attribution congela quando há fato (409 attribution_frozen)', async () => {
  const ep = await insertEpisodeWithTurns({ fonte: 'reuniao', external_source: 'vexa', external_id: 'vx-9', occurred_at: new Date(), workspace_id: 'ws-1', turns: [] } as any);
  const row = await createCollectedMeeting(pool, { meetCode: 'abc-defg-hij', workspaceId: 'ws-1', requestedBy: 'u' });
  await pool.query('UPDATE collected_meetings SET episode_id=$1, status=$2 WHERE id=$3', [ep.id, 'imported', row.id]);
  await pool.query(
    `INSERT INTO facts (workspace_id, fact_type, statement, confidence, valid_at, episode_id, episode_revision, turn_start, turn_end, embedding, embedding_model, extracted_by)
     VALUES ('ws-1','contexto','x',0.9,NOW(),$1,0,0,0, array_fill(0,ARRAY[1024])::vector,'m','t')`, [ep.id]);
  const app = buildApp();
  const r = await app.inject({ method: 'PATCH', url: `/meetings-collect/${row.id}/attribution`, headers: H, payload: { workspaceId: 'ws-2' } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'attribution_frozen');
});

test('PATCH attribution muda workspace quando não congelado', async () => {
  const ep = await insertEpisodeWithTurns({ fonte: 'reuniao', external_source: 'vexa', external_id: 'vx-10', occurred_at: new Date(), workspace_id: 'ws-1', turns: [] } as any);
  const row = await createCollectedMeeting(pool, { meetCode: 'abc-defg-hij', workspaceId: 'ws-1', requestedBy: 'u' });
  await pool.query('UPDATE collected_meetings SET episode_id=$1, status=$2 WHERE id=$3', [ep.id, 'imported', row.id]);
  const app = buildApp();
  const r = await app.inject({ method: 'PATCH', url: `/meetings-collect/${row.id}/attribution`, headers: H, payload: { workspaceId: 'ws-2' } });
  assert.equal(r.statusCode, 200);
  const check = await pool.query('SELECT workspace_id FROM episodes WHERE id=$1', [ep.id]);
  assert.equal(check.rows[0].workspace_id, 'ws-2');
});
