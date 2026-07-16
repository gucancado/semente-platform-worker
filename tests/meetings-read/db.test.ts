import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapMeetingListRow, fillDailySeries } from '../../src/meetings-read/db.js';

test('mapMeetingListRow converte episode_id (int8 string) em number', () => {
  const row = mapMeetingListRow({
    collected_id: 'uuid-1', episode_id: '202' as unknown as number, meet_code: 'aaa-bbbb-ccc',
    status: 'imported', failure_reason: null, title: 'T', occurred_at: new Date(),
    duration_seconds: 34, participants: [{ name: 'Gustavo', email: null }], sort_at: new Date(),
  });
  assert.equal(row.episode_id, 202);
  assert.equal(typeof row.episode_id, 'number');
});

test('mapMeetingListRow preserva episode_id nulo (reunião não importada)', () => {
  const row = mapMeetingListRow({
    collected_id: 'uuid-2', episode_id: null, meet_code: 'ddd-eeee-fff',
    status: 'failed', failure_reason: 'not_admitted', title: null, occurred_at: null,
    duration_seconds: null, participants: null, sort_at: new Date(),
  });
  assert.equal(row.episode_id, null);
});

test('fillDailySeries preenche dias vazios com zero no intervalo', () => {
  const out = fillDailySeries([{ day: '2026-07-02', count: 3 }], '2026-07-01', '2026-07-03');
  assert.deepEqual(out, [
    { day: '2026-07-01', count: 0 },
    { day: '2026-07-02', count: 3 },
    { day: '2026-07-03', count: 0 },
  ]);
});
