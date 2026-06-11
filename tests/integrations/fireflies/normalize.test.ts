import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentencesToTurns, transcriptToEpisodeInput } from '../../../src/integrations/fireflies/normalize.js';

test('funde sentenças consecutivas do mesmo falante em 1 turno', () => {
  const turns = sentencesToTurns([
    { index: 0, speaker_name: 'Ana', text: 'Oi.', start_time: 0, end_time: 1 },
    { index: 1, speaker_name: 'Ana', text: 'Tudo bem?', start_time: 1.2, end_time: 2 },
    { index: 2, speaker_name: 'Gustavo', text: 'Tudo!', start_time: 2.5, end_time: 3 },
    { index: 3, speaker_name: 'Ana', text: 'Ótimo.', start_time: 3.5, end_time: 4 },
  ]);
  assert.equal(turns.length, 3);
  assert.equal(turns[0]!.text, 'Oi. Tudo bem?');
  assert.equal(turns[0]!.speaker_name, 'Ana');
  assert.equal(turns[0]!.started_at_ms, 0);
  assert.equal(turns[0]!.ended_at_ms, 2000);
  assert.equal(turns[1]!.turn_index, 1);
});

test('speaker_name null vira turno anônimo com label preservado', () => {
  const turns = sentencesToTurns([{ index: 0, speaker_name: null, text: 'x', start_time: 0, end_time: 1 }]);
  assert.equal(turns[0]!.speaker_name, null);
  assert.equal(turns[0]!.speaker_label, null);
});

test('transcriptToEpisodeInput monta EpisodeInput completo', () => {
  const input = transcriptToEpisodeInput({
    id: 'ff-9', title: 'Kickoff', date: 1746100800000, duration: 30.5,
    host_email: 'g@beeads.com.br', organizer_email: 'g@beeads.com.br',
    participants: ['g@beeads.com.br', 'ana@tagless.com.br'],
    sentences: [{ index: 0, speaker_name: 'Ana', text: 'Oi', start_time: 0, end_time: 1 }],
  }, 'fireflies/ff-9.json');
  assert.equal(input.fonte, 'reuniao');
  assert.equal(input.external_source, 'fireflies');
  assert.equal(input.external_id, 'ff-9');
  assert.equal(input.occurred_at.getTime(), 1746100800000);
  assert.equal(input.duration_seconds, 1830);
  assert.equal(input.participants!.length, 2);
  assert.equal(input.turns.length, 1);
  assert.equal(input.raw_r2_key, 'fireflies/ff-9.json');
});
