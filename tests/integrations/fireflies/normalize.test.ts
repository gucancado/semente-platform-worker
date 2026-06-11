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

test('meeting_attendees enriquece participants com displayName; fallback para name null quando sem attendee', () => {
  const input = transcriptToEpisodeInput({
    id: 'ff-10', title: 'Demo', date: 1746100800000, duration: 45,
    participants: ['ana@tagless.com.br', 'g@beeads.com.br'],
    meeting_attendees: [{ displayName: 'Ana Souza', email: 'ana@tagless.com.br' }],
    sentences: [],
  }, null);
  assert.equal(input.participants!.length, 2);
  const ana = input.participants!.find((p) => p.email === 'ana@tagless.com.br');
  const g = input.participants!.find((p) => p.email === 'g@beeads.com.br');
  assert.equal(ana!.name, 'Ana Souza');
  assert.equal(g!.name, null);
});

test('meeting_attendees sem email é incluído como entrada extra (name-only)', () => {
  const input = transcriptToEpisodeInput({
    id: 'ff-11', title: 'Demo', date: 1746100800000, duration: 10,
    participants: ['g@beeads.com.br'],
    meeting_attendees: [
      { displayName: 'Convidado Externo', email: null },
      { displayName: null, name: 'Outro', email: 'g@beeads.com.br' },
    ],
    sentences: [],
  }, null);
  // g@beeads.com.br enriquecido via name (displayName null → cai para name)
  const g = input.participants!.find((p) => p.email === 'g@beeads.com.br');
  assert.equal(g!.name, 'Outro');
  // attendee sem email deve aparecer
  const noEmail = input.participants!.find((p) => p.email == null);
  assert.ok(noEmail, 'attendee sem email deve estar presente');
  assert.equal(noEmail!.name, 'Convidado Externo');
});

test('dedupe por email case-insensitive; metadata.attendees preserva raw', () => {
  const attendees = [{ displayName: 'Ana Souza', email: 'Ana@Tagless.com.br' }];
  const input = transcriptToEpisodeInput({
    id: 'ff-12', title: 'Demo', date: 1746100800000, duration: 10,
    participants: ['ana@tagless.com.br'],
    meeting_attendees: attendees,
    sentences: [],
  }, null);
  // sem duplicata
  assert.equal(input.participants!.length, 1);
  assert.equal(input.participants![0]!.name, 'Ana Souza');
  // raw preservado
  assert.deepEqual((input.metadata as Record<string, unknown>).attendees, attendees);
});
