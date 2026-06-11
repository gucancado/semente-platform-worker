import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { insertEpisodeWithTurns, getEpisode, listEpisodes, updateEpisodeAttribution } from '../../src/episodes/db.js';

const BASE = {
  fonte: 'reuniao' as const, external_source: 'fireflies', external_id: 'ff-1',
  title: 'Reunião Tagless', occurred_at: new Date('2026-05-01T14:00:00Z'),
  duration_seconds: 1800, participants: [{ name: 'Ana', email: 'ana@tagless.com.br' }],
  metadata: {}, raw_r2_key: 'fireflies/ff-1.json', audio_r2_key: null,
  workspace_id: 'wks-1', project_slug: 'tagless-brasil', attribution_method: 'domain' as const,
  turns: [
    { turn_index: 0, speaker_name: 'Ana', speaker_label: 'Ana', text: 'Oi, tudo bem?' },
    { turn_index: 1, speaker_name: 'Gustavo', speaker_label: 'Gustavo', text: 'Tudo! Vamos começar.' },
  ],
};

beforeEach(async () => {
  await pool.query('TRUNCATE episode_turns, episodes, event_outbox_deliveries, event_outbox RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('insert grava episódio + turnos + evento outbox na mesma TX', async () => {
  const r = await insertEpisodeWithTurns(BASE);
  assert.equal(r.duplicate, false);
  assert.equal(r.revision, 1);
  const ep = await getEpisode(r.id);
  assert.equal(ep!.turn_count, 2);
  assert.equal(ep!.turns.length, 2);
  const { rows: ev } = await pool.query(`SELECT event_type, payload FROM event_outbox`);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].event_type, 'episodio_pronto_v1');
  assert.equal(ev[0].payload.revision, 1);
  assert.equal(ev[0].payload.episode_id, r.id);
});

test('duplicata sem force: não regrava, não re-emite evento', async () => {
  await insertEpisodeWithTurns(BASE);
  const r2 = await insertEpisodeWithTurns(BASE);
  assert.equal(r2.duplicate, true);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM event_outbox`);
  assert.equal(rows[0].n, 1);
});

test('force: substitui turnos, bumpa revision, re-emite evento com revision nova', async () => {
  const r1 = await insertEpisodeWithTurns(BASE);
  const r2 = await insertEpisodeWithTurns({ ...BASE, turns: [{ turn_index: 0, speaker_name: 'Ana', speaker_label: 'Ana', text: 'corrigido' }], force: true });
  assert.equal(r2.id, r1.id);
  assert.equal(r2.revision, 2);
  const ep = await getEpisode(r1.id);
  assert.equal(ep!.turn_count, 1);
  assert.equal(ep!.turns[0]!.text, 'corrigido');
  const { rows } = await pool.query(`SELECT payload FROM event_outbox ORDER BY id`);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].payload.revision, 2);
});

test('listEpisodes pagina por cursor composto (occurred_at, id) e filtra órfãos', async () => {
  await insertEpisodeWithTurns({ ...BASE, external_id: 'a', occurred_at: new Date('2026-05-03T10:00:00Z') });
  await insertEpisodeWithTurns({ ...BASE, external_id: 'b', occurred_at: new Date('2026-05-02T10:00:00Z'), workspace_id: null, attribution_method: 'none' });
  await insertEpisodeWithTurns({ ...BASE, external_id: 'c', occurred_at: new Date('2026-05-01T10:00:00Z') });
  const p1 = await listEpisodes({ limit: 2 });
  assert.equal(p1.items.length, 2);
  assert.equal(p1.items[0]!.external_id, 'a');
  const p2 = await listEpisodes({ limit: 2, cursor: p1.next_cursor! });
  assert.equal(p2.items.length, 1);
  assert.equal(p2.items[0]!.external_id, 'c');
  const orphans = await listEpisodes({ orphans: true, limit: 10 });
  assert.equal(orphans.items.length, 1);
  assert.equal(orphans.items[0]!.external_id, 'b');
});

test('updateEpisodeAttribution grava método manual + histórico em metadata', async () => {
  const r = await insertEpisodeWithTurns({ ...BASE, workspace_id: null, attribution_method: 'none' });
  await updateEpisodeAttribution(r.id, { workspace_id: 'wks-9', project_slug: 'x', by: 'owner' });
  const ep = await getEpisode(r.id);
  assert.equal(ep!.workspace_id, 'wks-9');
  assert.equal(ep!.attribution_method, 'manual');
  const hist = (ep!.metadata as any).attribution_history;
  assert.equal(hist.length, 1);
  assert.equal(hist[0].by, 'owner');
});
