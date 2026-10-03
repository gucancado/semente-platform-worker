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

// ── pedido duplicado (mig 069): o Vexa recusa 2º bot na mesma sala ──────────
test('POST na mesma sala e mesmo workspace com coleta ativa reaproveita', async () => {
  let sends = 0;
  const app = buildApp({ sendBot: async (code: string) => { sends++; return { id: 901, native_meeting_id: code, status: 'joining', start_time: null, end_time: null, segments: [] }; } });
  const a = await app.inject({ method: 'POST', url: '/meetings-collect', headers: H, payload: { meetCode: 'abc-defg-hij', workspaceId: 'ws-1' } });
  const b = await app.inject({ method: 'POST', url: '/meetings-collect', headers: H, payload: { meetCode: 'abc-defg-hij', workspaceId: 'ws-1', title: 'Agendada' } });
  assert.equal(b.json().id, a.json().id);
  assert.equal(b.json().reused, true);
  assert.equal(a.json().reused, undefined);
  assert.equal(sends, 1, 'um bot só');
  const row = await getCollectedMeeting(pool, a.json().id);
  assert.equal(row!.title, 'Agendada', 'preenche título vazio');
});

test('POST na mesma sala de OUTRO workspace não reaproveita (isolamento de tenant)', async () => {
  const app = buildApp();
  const a = await app.inject({ method: 'POST', url: '/meetings-collect', headers: H, payload: { meetCode: 'abc-defg-hij', workspaceId: 'ws-1' } });
  const b = await app.inject({ method: 'POST', url: '/meetings-collect', headers: H, payload: { meetCode: 'abc-defg-hij', workspaceId: 'ws-2' } });
  assert.notEqual(b.json().id, a.json().id);
  assert.equal(b.json().reused, undefined);
  const row = await getCollectedMeeting(pool, a.json().id);
  assert.equal(row!.workspace_id, 'ws-1');
});

test('POST não reaproveita coleta terminal', async () => {
  const app = buildApp();
  const old = await createCollectedMeeting(pool, { meetCode: 'abc-defg-hij', workspaceId: null, requestedBy: 'x' });
  await updateCollectedMeeting(pool, old.id, { status: 'failed', failureReason: 'silent_room' });
  const r = await app.inject({ method: 'POST', url: '/meetings-collect', headers: H, payload: { meetCode: 'abc-defg-hij' } });
  assert.notEqual(r.json().id, old.id);
  assert.equal(r.json().reused, undefined);
});

test('POST duplicado estende a expiração da fila', async () => {
  const app = buildApp();
  const busy = await createCollectedMeeting(pool, { meetCode: 'aaa-bbbb-ccc', workspaceId: null, requestedBy: 'x' });
  await updateCollectedMeeting(pool, busy.id, { status: 'collecting' }); // ocupa o único slot
  const t1 = new Date(Date.now() + 30 * 60_000); const t2 = new Date(Date.now() + 200 * 60_000);
  const a = await app.inject({ method: 'POST', url: '/meetings-collect', headers: H, payload: { meetCode: 'abc-defg-hij', expiresAt: t1.toISOString() } });
  assert.equal(a.json().status, 'queued');
  const b = await app.inject({ method: 'POST', url: '/meetings-collect', headers: H, payload: { meetCode: 'abc-defg-hij', expiresAt: t2.toISOString() } });
  assert.equal(b.json().reused, true);
  const row = await getCollectedMeeting(pool, a.json().id);
  assert.equal(row!.queue_expires_at!.getTime(), t2.getTime());
});

test('POST duplicado em coleta collecting move a âncora de admissão pra agora', async () => {
  const app = buildApp();
  const old = await createCollectedMeeting(pool, { meetCode: 'abc-defg-hij', workspaceId: null, requestedBy: 'x' });
  const past = new Date(Date.now() - 15 * 60_000);
  await updateCollectedMeeting(pool, old.id, { status: 'collecting', startedAt: past });
  const before = Date.now();
  const r = await app.inject({ method: 'POST', url: '/meetings-collect', headers: H, payload: { meetCode: 'abc-defg-hij' } });
  assert.equal(r.json().id, old.id);
  assert.equal(r.json().status, 'collecting');
  const row = await getCollectedMeeting(pool, old.id);
  assert.ok(row!.started_at!.getTime() >= before - 1000, 'âncora andou pra agora');
});
