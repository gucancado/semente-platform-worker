import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { getMeetingsStats } from '../../src/meetings-read/db.js';

beforeEach(async () => {
  await pool.query('TRUNCATE collected_meetings, episode_turns, episodes RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('getMeetingsStats agrega volume, participantes e saúde', async () => {
  const ws = 'ws-s';
  const { rows: e1 } = await pool.query(
    `INSERT INTO episodes (fonte, external_source, external_id, title, occurred_at, duration_seconds, workspace_id, participants, metadata)
     VALUES ('reuniao','vexa','x1','R1','2026-07-10T12:00:00Z',120,$1,'[]','{"speaker_counts":{"Gustavo":5,"Ana":2}}') RETURNING id`, [ws]);
  await pool.query(
    `INSERT INTO episodes (fonte, external_source, external_id, title, occurred_at, duration_seconds, workspace_id, participants, metadata)
     VALUES ('reuniao','vexa','x2','R2','2026-07-11T12:00:00Z',60,$1,'[]','{"speaker_counts":{"Gustavo":3}}')`, [ws]);
  await pool.query(
    `INSERT INTO collected_meetings (meet_code, workspace_id, status, requested_by, episode_id, created_at)
     VALUES ('aaa-bbbb-ccc',$1,'imported','u',$2,'2026-07-10T12:05:00Z')`, [ws, Number(e1[0].id)]);
  await pool.query(
    `INSERT INTO collected_meetings (meet_code, workspace_id, status, failure_reason, requested_by, created_at)
     VALUES ('ddd-eeee-fff',$1,'failed','not_admitted','u','2026-07-11T09:00:00Z')`, [ws]);

  const stats = await getMeetingsStats(pool, { workspaceId: ws, since: '2026-07-10', until: '2026-07-11' });
  assert.equal(stats.total, 2);
  assert.equal(stats.totalSeconds, 180);
  assert.equal(stats.avgSeconds, 90);
  assert.equal(stats.daily.length, 2);
  assert.deepEqual(stats.daily.map((d) => d.count), [1, 1]);
  assert.deepEqual(stats.speakers, [{ speaker: 'Gustavo', segments: 8 }, { speaker: 'Ana', segments: 2 }]);
  assert.equal(stats.health.imported, 1);
  assert.equal(stats.health.failed, 1);
});
