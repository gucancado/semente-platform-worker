import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { listMeetings } from '../../src/meetings-read/db.js';

beforeEach(async () => {
  await pool.query('TRUNCATE collected_meetings, episode_turns, episodes RESTART IDENTITY CASCADE');
});
after(() => pool.end());

async function seedEpisode(ws: string, occurredAt: string, title: string): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO episodes (fonte, external_source, external_id, title, occurred_at, duration_seconds, workspace_id, participants, metadata)
     VALUES ('reuniao','vexa', $1, $2, $3, 60, $4, '[{"name":"Gustavo","email":null}]', '{"speaker_counts":{"Gustavo":3}}')
     RETURNING id`,
    [`ext-${title}`, title, occurredAt, ws],
  );
  return Number(rows[0].id);
}

test('listMeetings devolve reunião do workspace, importada e falha, e exclui workspace alheio', async () => {
  const ws = 'ws-a', alien = 'ws-b';
  const epId = await seedEpisode(ws, '2026-07-15T12:00:00Z', 'importada');
  await pool.query(
    `INSERT INTO collected_meetings (meet_code, workspace_id, status, requested_by, episode_id)
     VALUES ('aaa-bbbb-ccc',$1,'imported','u',$2)`, [ws, epId]);
  await pool.query(
    `INSERT INTO collected_meetings (meet_code, workspace_id, status, failure_reason, requested_by)
     VALUES ('ddd-eeee-fff',$1,'failed','not_admitted','u')`, [ws]);
  await pool.query(
    `INSERT INTO collected_meetings (meet_code, workspace_id, status, requested_by)
     VALUES ('ggg-hhhh-iii',$1,'collecting','u')`, [alien]);

  const rows = await listMeetings(pool, { workspaceId: ws });
  const codes = rows.map((r) => r.meet_code);
  assert.ok(codes.includes('aaa-bbbb-ccc'));           // importada
  assert.ok(codes.includes('ddd-eeee-fff'));           // falha (LEFT JOIN, sem episode)
  assert.ok(!codes.includes('ggg-hhhh-iii'));          // workspace alheio
  const imported = rows.find((r) => r.meet_code === 'aaa-bbbb-ccc')!;
  assert.equal(imported.title, 'importada');
  assert.equal(typeof imported.episode_id, 'number');
  const failed = rows.find((r) => r.meet_code === 'ddd-eeee-fff')!;
  assert.equal(failed.episode_id, null);
  assert.equal(failed.failure_reason, 'not_admitted');
});

test('listMeetings filtra por período em BRT', async () => {
  const ws = 'ws-c';
  const ep1 = await seedEpisode(ws, '2026-07-10T12:00:00Z', 'dentro');
  const ep2 = await seedEpisode(ws, '2026-07-01T12:00:00Z', 'fora');
  await pool.query(`INSERT INTO collected_meetings (meet_code, workspace_id, status, requested_by, episode_id) VALUES ('aaa-bbbb-ccc',$1,'imported','u',$2)`, [ws, ep1]);
  await pool.query(`INSERT INTO collected_meetings (meet_code, workspace_id, status, requested_by, episode_id) VALUES ('ddd-eeee-fff',$1,'imported','u',$2)`, [ws, ep2]);
  const rows = await listMeetings(pool, { workspaceId: ws, since: '2026-07-05', until: '2026-07-15' });
  assert.deepEqual(rows.map((r) => r.title), ['dentro']);
});
