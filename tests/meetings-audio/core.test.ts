import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickAudioRecording, audioKeyFor, parseRecordingFilename, audioDownloadName, AUDIO_URL_TTL_S,
} from '../../src/meetings-audio/core.js';
import { archiveFromVexa, runAudioBatch, storeEpisodeAudio } from '../../src/meetings-audio/service.js';

const rec = (id: number, meeting_id: number, types = ['audio']) => ({
  id, meeting_id, media_files: types.map((type, i) => ({ id: `${id}-${i}`, type, format: 'webm' })),
});

test('pickAudioRecording casa pelo id da reunião na Vexa', () => {
  const p = pickAudioRecording([rec(10, 198), rec(11, 199)], 199);
  assert.deepEqual(p, { recordingId: 11, mediaFileId: '11-0' });
});

test('pickAudioRecording: várias gravações da mesma reunião → a mais recente', () => {
  const p = pickAudioRecording([rec(30, 199), rec(12, 199), rec(20, 199)], 199);
  assert.equal(p?.recordingId, 30);
});

test('pickAudioRecording ignora gravação só de vídeo e reunião ausente', () => {
  assert.equal(pickAudioRecording([rec(1, 5, ['video'])], 5), null);
  assert.equal(pickAudioRecording([rec(1, 5)], 6), null);
  assert.equal(pickAudioRecording([], 6), null);
});

test('pickAudioRecording aceita meeting_id vindo como string', () => {
  const p = pickAudioRecording([{ id: 3, meeting_id: '199' as unknown as number, media_files: [{ id: 9, type: 'audio' }] }], 199);
  assert.equal(p?.recordingId, 3);
});

test('audioKeyFor é determinística', () => {
  assert.equal(audioKeyFor(199), 'vexa/audio/199.webm');
});

test('parseRecordingFilename lê o id do nome do arquivo do bot', () => {
  assert.equal(parseRecordingFilename('recording_199_b9d21ea6-40b0-47eb-ba0c-8f21c0fb0cd6.webm'), 199);
  assert.equal(parseRecordingFilename('remux_test.webm'), null);
  assert.equal(parseRecordingFilename('recording_199_x.mp3'), null);
});

test('audioDownloadName usa o dia de São Paulo, não o do UTC', () => {
  // 17/09 01:30 UTC = 16/09 22:30 em São Paulo
  assert.equal(audioDownloadName(471, new Date('2026-09-17T01:30:00Z')), 'reuniao-2026-09-16-471.webm');
});

test('TTL do link cobre uma reunião longa', () => {
  assert.ok(AUDIO_URL_TTL_S >= 3 * 3600);
});

function fakes() {
  const calls: string[] = [];
  const store = {
    remux: async (b: Buffer) => { calls.push('remux'); return Buffer.concat([b, Buffer.from('!')]); },
    put: async (key: string, body: Buffer, ct: string) => { calls.push(`put:${key}:${body.length}:${ct}`); },
    setKey: async (id: number, key: string) => { calls.push(`set:${id}:${key}`); return true; },
  };
  return { calls, store };
}

test('storeEpisodeAudio: remux antes do R2, chave só depois do upload', async () => {
  const { calls, store } = fakes();
  const r = await storeEpisodeAudio(store, { episodeId: 471, vexaMeetingId: 199, bytes: Buffer.from('abc') });
  assert.deepEqual(calls, ['remux', 'put:vexa/audio/199.webm:4:audio/webm', 'set:471:vexa/audio/199.webm']);
  assert.equal(r.bytes, 4);
});

test('storeEpisodeAudio: falha no upload não grava chave', async () => {
  const { calls, store } = fakes();
  await assert.rejects(storeEpisodeAudio(
    { ...store, put: async () => { throw new Error('r2 fora'); } },
    { episodeId: 1, vexaMeetingId: 2, bytes: Buffer.from('a') },
  ));
  assert.ok(!calls.some((c) => c.startsWith('set:')));
});

test('archiveFromVexa: sem gravação ainda → not_ready, sem download', async () => {
  const { store } = fakes();
  let downloads = 0;
  const out = await archiveFromVexa(
    { ...store, vexa: { listRecordings: async () => [], downloadRecordingAudio: async () => { downloads++; return Buffer.alloc(0); } } },
    { episodeId: 1, vexaMeetingId: 199, recordings: [] },
  );
  assert.equal(out, 'not_ready');
  assert.equal(downloads, 0);
});

test('runAudioBatch: lista a Vexa uma vez por ciclo e isola falhas por reunião', async () => {
  const { store, calls } = fakes();
  let lists = 0;
  const r = await runAudioBatch({
    ...store,
    listPending: async () => [{ episodeId: 1, vexaMeetingId: 10 }, { episodeId: 2, vexaMeetingId: 20 }, { episodeId: 3, vexaMeetingId: 30 }],
    vexa: {
      listRecordings: async () => { lists++; return [rec(100, 10), rec(200, 20)]; },
      downloadRecordingAudio: async (id) => { if (id === 100) throw new Error('500'); return Buffer.from('x'); },
    },
  });
  assert.equal(lists, 1);
  assert.deepEqual(r, { pending: 3, stored: 1 });
  assert.ok(calls.includes('set:2:vexa/audio/20.webm'));
});

test('runAudioBatch: nada pendente → não chama a Vexa', async () => {
  const { store } = fakes();
  let lists = 0;
  const r = await runAudioBatch({
    ...store, listPending: async () => [],
    vexa: { listRecordings: async () => { lists++; return []; }, downloadRecordingAudio: async () => Buffer.alloc(0) },
  });
  assert.equal(lists, 0);
  assert.deepEqual(r, { pending: 0, stored: 0 });
});
