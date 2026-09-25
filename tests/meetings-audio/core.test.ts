import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickAudioRecording, audioKeyFor, parseRecordingFilename, audioDownloadName, AUDIO_URL_TTL_S,
  repairHeaderlessWebm, WEBM_OPUS_INIT_HEX, audioCoversEpisode, firstSaneClusterAt,
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
  assert.equal(audioDownloadName(12, new Date('2026-06-01T15:00:00Z'), 'fireflies/abc.mp3'), 'reuniao-2026-06-01-12.mp3');
  assert.equal(audioDownloadName(471, new Date('2026-09-17T01:30:00Z'), 'vexa/audio/199.webm'), 'reuniao-2026-09-16-471.webm');
});

test('TTL do link cobre uma reunião longa', () => {
  assert.ok(AUDIO_URL_TTL_S >= 3 * 3600);
});

function fakes() {
  const calls: string[] = [];
  const store = {
    remux: async (b: Buffer) => { calls.push('remux'); return { bytes: Buffer.concat([b, Buffer.from('!')]), durationS: 600 }; },
    put: async (key: string, body: Buffer, ct: string) => { calls.push(`put:${key}:${body.length}:${ct}`); },
    setKey: async (id: number, key: string) => { calls.push(`set:${id}:${key}`); return true; },
  };
  return { calls, store };
}

test('storeEpisodeAudio: remux antes do R2, chave só depois do upload', async () => {
  const { calls, store } = fakes();
  const valid = Buffer.from('1a45dfa3aa', 'hex');
  const r = await storeEpisodeAudio(store, { episodeId: 471, vexaMeetingId: 199, bytes: valid, episodeDurationS: 656 });
  assert.deepEqual(calls, ['remux', 'put:vexa/audio/199.webm:6:audio/webm', 'set:471:vexa/audio/199.webm']);
  assert.equal(r.bytes, 6);
  assert.equal(r.repaired, false);
});

test('storeEpisodeAudio: gravação sem cabeçalho chega reparada ao remux', async () => {
  let seen: Buffer | null = null;
  const r = await storeEpisodeAudio(
    { remux: async (b) => { seen = b; return { bytes: b, durationS: 600 }; }, put: async () => {}, setKey: async () => true },
    { episodeId: 1, vexaMeetingId: 2, bytes: Buffer.from('8c81' + cluster(1000), 'hex'), episodeDurationS: 600 },
  );
  assert.equal(r.repaired, true);
  assert.ok(seen!.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex')));
});

test('storeEpisodeAudio: falha no upload não grava chave', async () => {
  const { calls, store } = fakes();
  await assert.rejects(storeEpisodeAudio(
    { ...store, put: async () => { throw new Error('r2 fora'); } },
    { episodeId: 1, vexaMeetingId: 2, bytes: Buffer.from('a'), episodeDurationS: 600 },
  ));
  assert.ok(!calls.some((c) => c.startsWith('set:')));
});

test('archiveFromVexa: sem gravação ainda → not_ready, sem download', async () => {
  const { store } = fakes();
  let downloads = 0;
  const out = await archiveFromVexa(
    { ...store, vexa: { listRecordings: async () => [], downloadRecordingAudio: async () => { downloads++; return Buffer.alloc(0); } } },
    { episodeId: 1, vexaMeetingId: 199, episodeDurationS: 600, recordings: [] },
  );
  assert.equal(out, 'not_ready');
  assert.equal(downloads, 0);
});

test('runAudioBatch: lista a Vexa uma vez por ciclo e isola falhas por reunião', async () => {
  const { store, calls } = fakes();
  let lists = 0;
  const r = await runAudioBatch({
    ...store,
    listPending: async () => [
      { episodeId: 1, vexaMeetingId: 10, episodeDurationS: 600 },
      { episodeId: 2, vexaMeetingId: 20, episodeDurationS: 600 },
      { episodeId: 3, vexaMeetingId: 30, episodeDurationS: 600 },
    ],
    vexa: {
      listRecordings: async () => { lists++; return [rec(100, 10), rec(200, 20)]; },
      downloadRecordingAudio: async (id) => { if (id === 100) throw new Error('500'); return Buffer.from('1a45dfa3', 'hex'); },
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

test('repairHeaderlessWebm: arquivo com cabeçalho passa intacto', () => {
  const ok = Buffer.from('1a45dfa3' + '00ff', 'hex');
  const r = repairHeaderlessWebm(ok);
  assert.equal(r.repaired, false);
  assert.equal(r.bytes, ok);
});

// Cluster sintético: ID + tamanho desconhecido + Timecode (e7, 4 bytes) + um SimpleBlock mínimo.
const cluster = (tcMs: number) =>
  '1f43b675' + '01ffffffffffffff' + 'e784' + tcMs.toString(16).padStart(8, '0') + 'a38c81000080ff03fffefffefffe';

test('repairHeaderlessWebm: começo com zeros (caso 245) recomeça no 1º cluster', () => {
  const bad = Buffer.from('8c813848' + '00'.repeat(40) + cluster(135346) + cluster(150406), 'hex');
  const r = repairHeaderlessWebm(bad);
  assert.equal(r.repaired, true);
  assert.equal(r.bytes.toString('hex'), WEBM_OPUS_INIT_HEX + cluster(135346) + cluster(150406));
});

test('repairHeaderlessWebm: fim da reunião gravado no começo (caso 234) é descartado', () => {
  // 1º cluster marcado em 2.226.525 ms, o seguinte em 240.702 ms: o 1º está fora de lugar.
  const bad = Buffer.from('8c81' + cluster(2226525) + 'ab'.repeat(20) + cluster(240702) + cluster(255760), 'hex');
  const r = repairHeaderlessWebm(bad);
  assert.equal(r.bytes.toString('hex'), WEBM_OPUS_INIT_HEX + cluster(240702) + cluster(255760));
});

test('firstSaneClusterAt devolve o timecode de onde o áudio passa a começar', () => {
  const b = Buffer.from('8c81' + cluster(2226525) + cluster(240702) + cluster(255760), 'hex');
  assert.equal(firstSaneClusterAt(b)?.timecodeMs, 240702);
});

test('repairHeaderlessWebm: sem cluster legível lança em vez de guardar lixo', () => {
  assert.throws(() => repairHeaderlessWebm(Buffer.from('8c81' + '00'.repeat(30), 'hex')));
});

test('WEBM_OPUS_INIT_HEX é um cabeçalho webm Opus completo', () => {
  const h = Buffer.from(WEBM_OPUS_INIT_HEX, 'hex');
  assert.equal(h.length, 146);
  assert.ok(h.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex')));
  assert.ok(h.includes(Buffer.from('A_OPUS')));
  assert.ok(h.includes(Buffer.from('OpusHead')));
});

test('audioCoversEpisode: exige metade da duração da reunião', () => {
  assert.equal(audioCoversEpisode(693, 656), true);     // Chianca 16/09
  assert.equal(audioCoversEpisode(948, 964), true);     // reparada, perdeu ~2 min
  assert.equal(audioCoversEpisode(15, 190), false);     // ep. 448
  assert.equal(audioCoversEpisode(1.2, 2400), false);   // sobra de 3 KB do 2º master
  assert.equal(audioCoversEpisode(null, 600), false);   // ffprobe não leu
  assert.equal(audioCoversEpisode(45, null), true);     // sem duração do episódio: piso de 30s
  assert.equal(audioCoversEpisode(10, 0), false);
});

test('storeEpisodeAudio: áudio curto não sobe pro R2 nem grava chave', async () => {
  const calls: string[] = [];
  const r = await storeEpisodeAudio(
    {
      remux: async (b) => ({ bytes: b, durationS: 1.2 }),
      put: async () => { calls.push('put'); },
      setKey: async () => { calls.push('set'); return true; },
    },
    { episodeId: 9, vexaMeetingId: 251, bytes: Buffer.from('1a45dfa3', 'hex'), episodeDurationS: 1200 },
  );
  assert.equal(r.tooShort, true);
  assert.deepEqual(calls, []);
});

test('archiveFromVexa: áudio curto → too_short', async () => {
  const out = await archiveFromVexa(
    {
      remux: async (b) => ({ bytes: b, durationS: 2 }), put: async () => {}, setKey: async () => true,
      vexa: { listRecordings: async () => [], downloadRecordingAudio: async () => Buffer.from('1a45dfa3', 'hex') },
    },
    { episodeId: 9, vexaMeetingId: 251, episodeDurationS: 1200, recordings: [rec(1, 251)] },
  );
  assert.equal(out, 'too_short');
});

import { audioOffsetMs } from '../../src/meetings-read/db.js';
import { vexaMeetingToEpisodeInput } from '../../src/integrations/vexa/normalize.js';

test('audioOffsetMs: atraso da 1ª fala menos o trecho perdido', () => {
  assert.equal(audioOffsetMs({ first_segment_offset_ms: 33300 }), 33300);
  assert.equal(audioOffsetMs({ first_segment_offset_ms: 7000, audio_start_ms: 14408 }), -7408);
  assert.equal(audioOffsetMs({}), 0);          // Fireflies: turnos e áudio partem juntos
  assert.equal(audioOffsetMs(null), 0);
  assert.equal(audioOffsetMs({ first_segment_offset_ms: '1200' }), 1200);
});

test('importação grava first_segment_offset_ms = 1ª fala − início da reunião', () => {
  const ep = vexaMeetingToEpisodeInput({
    id: 480, platform: 'google_meet', native_meeting_id: 'abc-defg-hij', status: 'completed',
    start_time: '2026-09-23T17:46:17.978', end_time: '2026-09-23T18:12:00',
    segments: [
      { start: Date.parse('2026-09-23T17:46:51.300Z') / 1000, end: Date.parse('2026-09-23T17:46:55Z') / 1000, text: 'oi', language: 'pt', speaker: 'A' },
    ],
  } as never, null);
  assert.equal((ep.metadata as Record<string, unknown>).first_segment_offset_ms, 33322);
  assert.equal(ep.turns![0].started_at_ms, 0);
});

test('storeEpisodeAudio repassa onde o áudio começa na gravação original', async () => {
  let got: number | null = null;
  await storeEpisodeAudio(
    {
      remux: async (b) => ({ bytes: b, durationS: 900, startS: 14.408 }),
      put: async () => {},
      setKey: async (_id, _k, startMs) => { got = startMs; return true; },
    },
    { episodeId: 1, vexaMeetingId: 2, bytes: Buffer.from('1a45dfa3', 'hex'), episodeDurationS: 964 },
  );
  assert.equal(got, 14408);
});
