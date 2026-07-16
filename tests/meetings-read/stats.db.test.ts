import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { getMeetingsStats } from '../../src/meetings-read/db.js';

beforeEach(async () => {
  await pool.query('TRUNCATE collected_meetings, episode_turns, episodes RESTART IDENTITY CASCADE');
});
after(() => pool.end());

async function seedEp(ws: string, ext: string, occurredAt: string, dur: number): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO episodes (fonte, external_source, external_id, title, occurred_at, duration_seconds, workspace_id, participants, metadata)
     VALUES ('reuniao', $4, $5, 'R', $2, $3, $1, '[]', '{}') RETURNING id`,
    [ws, occurredAt, dur, ext, `x-${occurredAt}`],
  );
  return Number(rows[0].id);
}
async function seedTurns(epId: number, speaker: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await pool.query(
      `INSERT INTO episode_turns (episode_id, turn_index, speaker_name, text)
       VALUES ($1, (SELECT COALESCE(MAX(turn_index),-1)+1 FROM episode_turns WHERE episode_id=$1), $2, 'fala')`,
      [epId, speaker],
    );
  }
}

test('getMeetingsStats: volume de fonte=reuniao, speakers dos turns, saúde do collected_meetings', async () => {
  const ws = 'ws-s';
  // duas reuniões fireflies (sem metadata.speaker_counts — speakers vêm dos turns)
  const e1 = await seedEp(ws, 'fireflies', '2026-07-10T12:00:00Z', 120);
  const e2 = await seedEp(ws, 'fireflies', '2026-07-11T12:00:00Z', 60);
  await seedTurns(e1, 'Gustavo', 5);
  await seedTurns(e1, 'Ana', 2);
  await seedTurns(e2, 'Gustavo', 3);
  // saúde: pipeline Vexa (collected_meetings) — pode coexistir sem episode
  await pool.query(
    `INSERT INTO collected_meetings (meet_code, workspace_id, status, requested_by, episode_id, created_at)
     VALUES ('aaa-bbbb-ccc',$1,'imported','u',$2,'2026-07-10T12:05:00Z')`, [ws, e1]);
  await pool.query(
    `INSERT INTO collected_meetings (meet_code, workspace_id, status, failure_reason, requested_by, created_at)
     VALUES ('ddd-eeee-fff',$1,'failed','not_admitted','u','2026-07-11T09:00:00Z')`, [ws]);

  const stats = await getMeetingsStats(pool, { workspaceId: ws, since: '2026-07-10', until: '2026-07-11' });
  assert.equal(stats.total, 2);
  assert.equal(stats.total_seconds, 180);
  assert.equal(stats.avg_seconds, 90);
  assert.equal(stats.daily.length, 2);
  assert.deepEqual(stats.daily.map((d) => d.count), [1, 1]);
  assert.deepEqual(stats.speakers, [{ speaker: 'Gustavo', segments: 8 }, { speaker: 'Ana', segments: 2 }]);
  assert.equal(stats.health.imported, 1);
  assert.equal(stats.health.failed, 1);
});
