import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapCollectedMeetingRow } from '../../src/meetings-collect/db.js';

// episode_id é BIGINT: o driver pg devolve int8 como STRING, não number. O tipo
// CollectedMeetingRow declara `number | null`, então sem normalizar o tipo mente
// e o contrato meetings_v1 (episode_id: number) sai violado na resposta HTTP.
test('mapCollectedMeetingRow converte episode_id (int8 -> string) em number', () => {
  const row = mapCollectedMeetingRow({
    id: 'a2625fa6', meet_code: 'jnn-panf-sby', vexa_meeting_id: 5, workspace_id: 'ws',
    status: 'imported', failure_reason: null, requested_by: 'u', last_segment_at: null,
    episode_id: '202' as unknown as number, title: null, queue_expires_at: null,
    created_at: new Date(), updated_at: new Date(),
  });
  assert.equal(row.episode_id, 202);
  assert.equal(typeof row.episode_id, 'number');
});

test('mapCollectedMeetingRow preserva episode_id nulo', () => {
  const row = mapCollectedMeetingRow({
    id: 'x', meet_code: 'aaa-bbbb-ccc', vexa_meeting_id: null, workspace_id: null,
    status: 'collecting', failure_reason: null, requested_by: 'u', last_segment_at: null,
    episode_id: null, title: null, queue_expires_at: null,
    created_at: new Date(), updated_at: new Date(),
  });
  assert.equal(row.episode_id, null);
});

test('mapCollectedMeetingRow não estraga episode_id que já veio number', () => {
  const row = mapCollectedMeetingRow({
    id: 'x', meet_code: 'aaa-bbbb-ccc', vexa_meeting_id: null, workspace_id: null,
    status: 'imported', failure_reason: null, requested_by: 'u', last_segment_at: null,
    episode_id: 7, title: null, queue_expires_at: null,
    created_at: new Date(), updated_at: new Date(),
  });
  assert.equal(row.episode_id, 7);
});
