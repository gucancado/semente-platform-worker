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
