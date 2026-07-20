import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import {
  createCollectedMeeting, getActiveCollectedMeeting, getCollectedMeeting,
  listActiveCollectedMeetings, updateCollectedMeeting, isEpisodeFrozen, reattributeEpisode,
} from '../../src/meetings-collect/db.js';

beforeEach(async () => {
  await pool.query('TRUNCATE collected_meetings, facts, episode_turns, episodes RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('create + getActive + get', async () => {
  const row = await createCollectedMeeting(pool, { meetCode: 'abc-defg-hij', workspaceId: 'ws-1', requestedBy: 'user-1' });
  assert.equal(row.status, 'queued'); // nasce na fila (default novo)
  assert.equal(row.meet_code, 'abc-defg-hij');
  // getActive só enxerga collecting/stopping — promove antes de checar.
  await updateCollectedMeeting(pool, row.id, { status: 'collecting' });
  const active = await getActiveCollectedMeeting(pool);
  assert.equal(active!.id, row.id);
  const fetched = await getCollectedMeeting(pool, row.id);
  assert.equal(fetched!.requested_by, 'user-1');
});

test('getActive ignora terminais (imported/failed/canceled)', async () => {
  const row = await createCollectedMeeting(pool, { meetCode: 'abc-defg-hij', workspaceId: null, requestedBy: 'u' });
  await updateCollectedMeeting(pool, row.id, { status: 'imported', episodeId: null });
  assert.equal(await getActiveCollectedMeeting(pool), null);
  assert.equal((await listActiveCollectedMeetings(pool)).length, 0);
});

test('update aplica patch parcial', async () => {
  const row = await createCollectedMeeting(pool, { meetCode: 'abc-defg-hij', workspaceId: null, requestedBy: 'u' });
  await updateCollectedMeeting(pool, row.id, { vexaMeetingId: 42, lastSegmentAt: new Date('2026-07-13T12:00:00Z') });
  const r = await getCollectedMeeting(pool, row.id);
  assert.equal(r!.vexa_meeting_id, 42);
  assert.equal(r!.status, 'queued'); // patch não mexe em status → segue o default 'queued'
});

test('isEpisodeFrozen: true sse existe fato para o episodio', async () => {
  const ep = await pool.query(
    `INSERT INTO episodes (fonte, external_source, external_id, occurred_at, turn_count)
     VALUES ('reuniao','vexa','vx-1', NOW(), 0) RETURNING id`);
  const episodeId = ep.rows[0].id as number;
  assert.equal(await isEpisodeFrozen(pool, episodeId), false);
  await pool.query(
    `INSERT INTO facts (workspace_id, fact_type, statement, confidence, valid_at, episode_id, episode_revision, turn_start, turn_end, embedding, embedding_model, extracted_by)
     VALUES ('ws-1','contexto','x',0.9, NOW(), $1, 0, 0, 0, array_fill(0,ARRAY[1024])::vector, 'm', 't')`, [episodeId]);
  assert.equal(await isEpisodeFrozen(pool, episodeId), true);
});

test('reattributeEpisode muda workspace_id do episodio', async () => {
  const ep = await pool.query(
    `INSERT INTO episodes (fonte, external_source, external_id, occurred_at, turn_count, workspace_id)
     VALUES ('reuniao','vexa','vx-2', NOW(), 0, 'ws-old') RETURNING id`);
  const episodeId = ep.rows[0].id as number;
  await reattributeEpisode(pool, episodeId, 'ws-new');
  const r = await pool.query('SELECT workspace_id FROM episodes WHERE id=$1', [episodeId]);
  assert.equal(r.rows[0].workspace_id, 'ws-new');
});
