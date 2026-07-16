import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { listMeetings } from '../../src/meetings-read/db.js';

beforeEach(async () => {
  await pool.query('TRUNCATE collected_meetings, episode_turns, episodes RESTART IDENTITY CASCADE');
});
after(() => pool.end());

async function seedEpisode(ws: string, occurredAt: string, title: string, externalSource = 'vexa'): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO episodes (fonte, external_source, external_id, title, occurred_at, duration_seconds, workspace_id, participants, metadata)
     VALUES ('reuniao', $5, $1, $2, $3, 60, $4, '[{"name":"Gustavo","email":null}]', '{}')
     RETURNING id`,
    [`ext-${title}`, title, occurredAt, ws, externalSource],
  );
  return Number(rows[0].id);
}

test('listMeetings devolve fireflies (sem coleta) + vexa importada, exclui workspace alheio', async () => {
  const ws = 'ws-a', alien = 'ws-b';
  // fireflies: episódio fonte=reuniao SEM linha de collected_meetings
  const ff = await seedEpisode(ws, '2026-07-14T12:00:00Z', 'fireflies-call', 'fireflies');
  // vexa: episódio + collected_meetings
  const vx = await seedEpisode(ws, '2026-07-15T12:00:00Z', 'vexa-call', 'vexa');
  await pool.query(
    `INSERT INTO collected_meetings (meet_code, workspace_id, status, requested_by, episode_id)
     VALUES ('aaa-bbbb-ccc',$1,'imported','u',$2)`, [ws, vx]);
  // workspace alheio (não deve aparecer)
  await seedEpisode(alien, '2026-07-15T12:00:00Z', 'alien-call', 'fireflies');
  // coleta vexa FALHA sem episode → lista dirigida por episodes NÃO a mostra (não tem transcrição)
  await pool.query(
    `INSERT INTO collected_meetings (meet_code, workspace_id, status, failure_reason, requested_by)
     VALUES ('ddd-eeee-fff',$1,'failed','not_admitted','u')`, [ws]);

  const rows = await listMeetings(pool, { workspaceId: ws });
  assert.deepEqual(rows.map((r) => r.title).sort(), ['fireflies-call', 'vexa-call']);
  const ffRow = rows.find((r) => r.title === 'fireflies-call')!;
  assert.equal(ffRow.collected_id, null);        // fireflies não tem coleta
  assert.equal(ffRow.status, 'transcribed');     // COALESCE do status
  assert.equal(ffRow.episode_id, ff);
  assert.equal(typeof ffRow.episode_id, 'number');
  assert.equal(ffRow.meet_code, null);           // sem meet_code (não é Vexa)
  const vxRow = rows.find((r) => r.title === 'vexa-call')!;
  assert.equal(vxRow.meet_code, 'aaa-bbbb-ccc');
  assert.equal(vxRow.status, 'imported');
});

test('listMeetings filtra por período em BRT', async () => {
  const ws = 'ws-c';
  await seedEpisode(ws, '2026-07-10T12:00:00Z', 'dentro', 'fireflies');
  await seedEpisode(ws, '2026-07-01T12:00:00Z', 'fora', 'fireflies');
  const rows = await listMeetings(pool, { workspaceId: ws, since: '2026-07-05', until: '2026-07-15' });
  assert.deepEqual(rows.map((r) => r.title), ['dentro']);
});
