import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { getMeetingTranscript } from '../../src/meetings-read/db.js';

beforeEach(async () => {
  await pool.query('TRUNCATE collected_meetings, episode_turns, episodes RESTART IDENTITY CASCADE');
});
after(() => pool.end());

async function seed(ws: string, fonte = 'reuniao', ext = 'fireflies'): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO episodes (fonte, external_source, external_id, title, occurred_at, duration_seconds, workspace_id, participants, metadata)
     VALUES ($2, $3, $4, 'R','2026-07-10T12:00:00Z',34,$1,'[{"name":"Gustavo","email":null}]','{}') RETURNING id`,
    [ws, fonte, ext, `x-${fonte}-${ws}`]);
  const id = Number(rows[0].id);
  await pool.query(
    `INSERT INTO episode_turns (episode_id, turn_index, speaker_name, started_at_ms, ended_at_ms, text)
     VALUES ($1,0,'Gustavo',0,34000,'oi, teste')`, [id]);
  return id;
}

test('getMeetingTranscript devolve turns de episódio de reunião fireflies do workspace certo', async () => {
  const id = await seed('ws-a');
  const t = await getMeetingTranscript(pool, { episodeId: id, workspaceId: 'ws-a' });
  assert.ok(t);
  assert.equal(t!.episode.id, id);
  assert.equal(typeof t!.episode.id, 'number');
  assert.equal(t!.turns.length, 1);
  assert.equal(t!.turns[0].text, 'oi, teste');
});

test('getMeetingTranscript retorna null para episódio que NÃO é reunião (fonte=whatsapp)', async () => {
  const id = await seed('ws-a', 'whatsapp', 'evolution');
  const t = await getMeetingTranscript(pool, { episodeId: id, workspaceId: 'ws-a' });
  assert.equal(t, null);
});

test('getMeetingTranscript retorna null para episódio de OUTRO workspace (segurança)', async () => {
  const id = await seed('ws-a');
  const t = await getMeetingTranscript(pool, { episodeId: id, workspaceId: 'ws-b' });
  assert.equal(t, null);
});

test('getMeetingTranscript retorna null para episódio inexistente', async () => {
  const t = await getMeetingTranscript(pool, { episodeId: 999999, workspaceId: 'ws-a' });
  assert.equal(t, null);
});
