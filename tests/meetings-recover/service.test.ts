import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processRecoveryJob, type RecoverDeps } from '../../src/meetings-recover/service.js';
import type { RecoveryJob } from '../../src/meetings-recover/db.js';

// O job inteiro com dependências falsas: gravação, ffmpeg, diarização, R2 e
// episódio. O pool falso devolve a linha do tempo do bot quando pedida.

const NOW = new Date('2026-10-02T15:00:00Z');
const START = '2026-10-02T12:47:41.774626';

const job = (over: Partial<RecoveryJob> = {}): RecoveryJob => ({
  collected_meeting_id: 'c1', reason: 'silent_room', attempts: 0, created_at: new Date('2026-10-02T13:10:00Z'),
  meet_code: 'ekt-trvt-tpv', vexa_meeting_id: 281, workspace_id: 'ws-natura', title: 'Estratégia',
  started_at: new Date('2026-10-02T12:47:26Z'), requested_at: new Date('2026-10-02T12:47:26Z'), episode_id: null,
  ...over,
});

function pool(activity: Array<{ speaker: string; started_at: Date; ended_at: Date }> = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    pool: {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (/FROM meeting_speaker_activity/.test(sql)) return { rows: activity };
        return { rows: [], rowCount: 1 };
      },
    } as any,
  };
}

function deps(p: any, o: {
  speech?: number; health?: 'ok' | 'down'; recordings?: unknown[];
  diar?: (i: number, refs: string[]) => Array<{ speaker: string; start: number; end: number; text: string }>;
  inserted?: any[]; puts?: string[]; refsSeen?: string[][]; clips?: number[][];
}): RecoverDeps {
  let chunk = 0;
  return {
    pool: p,
    vexa: {
      listRecordings: async () => (o.recordings ?? [{ id: 9, meeting_id: 281, media_files: [{ id: 5, type: 'audio' }] }]) as any,
      downloadRecordingAudio: async () => Buffer.from('webm'),
      getMeeting: async () => ({ id: 281, start_time: START, end_time: null, status: 'completed' }) as any,
    },
    remux: async () => ({ bytes: Buffer.from('remuxed'), durationS: 500 }),
    openRecording: async () => ({
      speechSeconds: async () => o.speech ?? 300,
      chunkMp3: async () => Buffer.from('mp3'),
      clipWav: async (s: number, l: number) => { o.clips?.push([s, l]); return Buffer.from('wav'); },
      dispose: async () => {},
    }),
    transcribe: async (_mp3, refs) => {
      o.refsSeen?.push(refs.map((r) => r.name));
      return { segments: (o.diar ?? (() => [{ speaker: 'A', start: 1, end: 9, text: 'oi' }]))(chunk++, refs.map((r) => r.name)) };
    },
    put: async (k) => { o.puts?.push(k); },
    insertEpisode: (async (input: any) => { o.inserted?.push(input); return { id: '489', duplicate: false, revision: 1 }; }) as any,
    health: async () => ({ state: o.health ?? 'ok' }),
    model: 'gpt-4o-transcribe-diarize',
    now: () => NOW,
  };
}

const t0 = new Date(START + 'Z').getTime();
const at = (s: number) => new Date(t0 + s * 1000);

test('conta fora: reagenda sem consumir tentativa', async () => {
  const { pool: p, calls } = pool();
  const r = await processRecoveryJob(deps(p, { health: 'down' }), job());
  assert.equal(r, 'retry');
  assert.ok(calls.some((c) => /status = 'pending'/.test(c.sql) && c.params[2] === 0));
});

test('gravação ainda não chegou: reagenda', async () => {
  const { pool: p } = pool();
  assert.equal(await processRecoveryJob(deps(p, { recordings: [] }), job()), 'retry');
});

test('gravação sem conversa → no_speech, sem episódio', async () => {
  const { pool: p, calls } = pool();
  const inserted: any[] = [];
  assert.equal(await processRecoveryJob(deps(p, { speech: 5, inserted }), job()), 'no_speech');
  assert.equal(inserted.length, 0);
  assert.ok(calls.some((c) => c.params.includes('no_speech')));
});

test('com linha do tempo do bot: nomes reais desde o 1º pedaço', async () => {
  const activity = [
    { speaker: 'Lucas Marques', started_at: at(10), ended_at: at(40) },
    { speaker: 'Gustavo Cançado', started_at: at(60), ended_at: at(70) },
    { speaker: 'Speaker', started_at: at(80), ended_at: at(95) },
  ];
  const { pool: p, calls } = pool(activity);
  const inserted: any[] = []; const puts: string[] = []; const refsSeen: string[][] = [];
  const r = await processRecoveryJob(deps(p, {
    inserted, puts, refsSeen,
    diar: (i) => i === 0
      ? [
          { speaker: 'Lucas Marques', start: 11, end: 20, text: 'bom dia' },
          { speaker: 'A', start: 61, end: 69, text: 'tudo certo' }, // linha do tempo diz Gustavo
          { speaker: 'B', start: 300, end: 305, text: 'hum' },     // ninguém cobre
          { speaker: 'Lucas Marques', start: 25, end: 30, text: 'vamos lá' },
        ]
      : [],
  }), job());
  assert.equal(r, 'done');
  assert.deepEqual(refsSeen[0], ['Lucas Marques', 'Gustavo Cançado']);
  const ep = inserted[0];
  assert.equal(ep.title, 'Estratégia');
  assert.equal(ep.workspace_id, 'ws-natura');
  assert.equal(ep.external_id, '281');
  assert.equal(ep.audio_r2_key, 'vexa/audio/281.webm');
  assert.equal(ep.metadata.recovered_from_audio, true);
  assert.equal(ep.force, undefined);
  assert.deepEqual(ep.turns.map((t: any) => t.speaker_name), ['Lucas Marques', 'Gustavo Cançado', 'Não identificado']);
  assert.ok(puts.includes('vexa/recovered/281.json'));
  assert.ok(calls.some((c) => /UPDATE collected_meetings/.test(c.sql) && c.params.includes('imported')));
  assert.ok(calls.some((c) => c.params.includes('done')));
});

test('sem linha do tempo: voz nova vira Falante N com amostra; 5ª voz sem nome', async () => {
  const { pool: p } = pool([]);
  const inserted: any[] = []; const refsSeen: string[][] = [];
  await processRecoveryJob(deps(p, {
    inserted, refsSeen,
    diar: (i, refs) => i === 0
      ? ['A', 'B', 'C', 'D', 'E'].map((l, k) => ({ speaker: l, start: k * 10, end: k * 10 + 5, text: `t${k}` }))
      : [{ speaker: refs[1]!, start: 1, end: 6, text: 'de novo' }, { speaker: 'A', start: 10, end: 15, text: 'quem?' }],
  }), job());
  assert.deepEqual(refsSeen[1], ['Falante 1', 'Falante 2', 'Falante 3', 'Falante 4']);
  const names = inserted[0].turns.map((t: any) => t.speaker_name);
  assert.deepEqual(names.slice(0, 5), ['Falante 1', 'Falante 2', 'Falante 3', 'Falante 4', 'Não identificado']);
  assert.ok(names.includes('Falante 2'));
  assert.equal(names.filter((n: string) => /^Falante [5-9]/.test(n)).length, 0, 'nunca passa de 4');
});

test("reason 'partial' substitui o episódio existente (force)", async () => {
  const { pool: p } = pool([]);
  const inserted: any[] = [];
  await processRecoveryJob(deps(p, {
    inserted, diar: () => [1, 2, 3].map((k) => ({ speaker: 'A', start: k * 10, end: k * 10 + 8, text: `x${k}` })),
  }), job({ reason: 'partial', episode_id: 487 }));
  assert.equal(inserted[0].force, true);
});

test('erro de item consome tentativa; no limite falha', async () => {
  const { pool: p, calls } = pool([]);
  const d = deps(p, {});
  d.transcribe = async () => { throw new Error('arquivo corrompido'); };
  assert.equal(await processRecoveryJob(d, job({ attempts: 0 })), 'retry');
  assert.ok(calls.some((c) => /status = 'pending'/.test(c.sql) && c.params[2] === 1));
  assert.equal(await processRecoveryJob(d, job({ attempts: 2 })), 'failed');
});
