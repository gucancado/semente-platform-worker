import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerMeetingsReadRoutes } from '../../src/meetings-read/routes.js';

const PANEL = 'test-panel-token';
const H = { 'x-panel-token': PANEL, 'x-acting-user': 'u1' };

function buildApp() {
  const app = Fastify();
  registerMeetingsReadRoutes(app, { pool, panelToken: PANEL });
  return app;
}

beforeEach(async () => {
  await pool.query('TRUNCATE collected_meetings, episode_turns, episodes RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('401 sem X-Panel-Token', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/meetings-read?workspace_id=ws-a' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET lista devolve schema meetings_read_v1', async () => {
  const app = buildApp();
  const { rows } = await pool.query(
    `INSERT INTO episodes (fonte, external_source, external_id, title, occurred_at, duration_seconds, workspace_id, participants, metadata)
     VALUES ('reuniao','vexa','x','R','2026-07-10T12:00:00Z',34,'ws-a','[]','{}') RETURNING id`);
  await pool.query(
    `INSERT INTO collected_meetings (meet_code, workspace_id, status, requested_by, episode_id)
     VALUES ('aaa-bbbb-ccc','ws-a','imported','u',$1)`, [Number(rows[0].id)]);
  const res = await app.inject({ method: 'GET', url: '/meetings-read?workspace_id=ws-a', headers: H });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schema, 'meetings_read_v1');
  assert.equal(body.meetings.length, 1);
  assert.equal(body.meetings[0].episode_id, Number(rows[0].id));
  await app.close();
});

test('GET transcript de outro workspace → 404', async () => {
  const app = buildApp();
  const { rows } = await pool.query(
    `INSERT INTO episodes (fonte, external_source, external_id, title, occurred_at, duration_seconds, workspace_id, participants, metadata)
     VALUES ('reuniao','vexa','x','R','2026-07-10T12:00:00Z',34,'ws-a','[]','{}') RETURNING id`);
  const id = Number(rows[0].id);
  const res = await app.inject({ method: 'GET', url: `/meetings-read/${id}/transcript?workspace_id=ws-b`, headers: H });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('include_failed: só falhas sem episódio, do workspace, no período BRT, com rótulo', async () => {
  const app = Fastify();
  registerMeetingsReadRoutes(app, { pool, panelToken: PANEL, admissionTimeoutMin: 20 });
  const ins = (code: string, ws: string, status: string, reason: string | null, createdAt: string) => pool.query(
    `INSERT INTO collected_meetings (meet_code, workspace_id, status, failure_reason, requested_by, created_at, failure_detail, vexa_status)
     VALUES ($1,$2,$3,$4,'u',$5,'det','awaiting_admission')`, [code, ws, status, reason, createdAt]);
  await ins('aaa-aaaa-aaa', 'ws-a', 'failed', 'silent_room', '2026-10-02T17:00:00Z');
  await ins('bbb-bbbb-bbb', 'ws-a', 'canceled', 'stopped_empty', '2026-10-02T02:30:00Z'); // 01/10 23:30 BRT → fora
  await ins('ccc-cccc-ccc', 'ws-b', 'failed', 'vexa_failed', '2026-10-02T17:00:00Z');      // outro workspace
  await ins('ddd-dddd-ddd', 'ws-a', 'collecting', null, '2026-10-02T17:00:00Z');            // ativa
  const res = await app.inject({ method: 'GET', url: '/meetings-read?workspace_id=ws-a&since=2026-10-02&until=2026-10-02&include_failed=1', headers: H });
  assert.equal(res.statusCode, 200);
  const failed = res.json().failed;
  assert.equal(failed.length, 1);
  assert.equal(failed[0].meet_code, 'aaa-aaaa-aaa');
  assert.equal(failed[0].failure_reason, 'silent_room');
  assert.match(failed[0].failure_label, /primeiros 20 min/);
  assert.equal(failed[0].failure_detail, 'det');
  assert.equal(failed[0].vexa_status, 'awaiting_admission');
  assert.equal(failed[0].requested_at, '2026-10-02T17:00:00.000Z');
  assert.equal(failed[0].started_at, null);
  assert.ok(failed[0].ended_at);
  // sem o parâmetro, a chave nem existe
  const plain = await app.inject({ method: 'GET', url: '/meetings-read?workspace_id=ws-a', headers: H });
  assert.equal('failed' in plain.json(), false);
  await app.close();
});

test('digest expõe decisões/ações/pendências (null em digest antigo)', async () => {
  const app = buildApp();
  const { rows } = await pool.query(
    `INSERT INTO episodes (fonte, external_source, external_id, title, occurred_at, duration_seconds, workspace_id, participants, metadata,
                           summary, summary_decisions, summary_actions, summary_open_questions)
     VALUES ('reuniao','vexa','y','R','2026-07-10T12:00:00Z',34,'ws-a','[]','{}','S',
             '["Pausar Meta"]','[{"what":"Enviar relatório","owner":null,"due":"sexta"}]','[]') RETURNING id`);
  const res = await app.inject({ method: 'GET', url: `/meetings-read/${Number(rows[0].id)}/digest?workspace_id=ws-a`, headers: H });
  const ep = res.json().episode;
  assert.deepEqual(ep.summary_decisions, ['Pausar Meta']);
  assert.deepEqual(ep.summary_actions, [{ what: 'Enviar relatório', owner: null, due: 'sexta' }]);
  assert.deepEqual(ep.summary_open_questions, []);
  await app.close();
});
