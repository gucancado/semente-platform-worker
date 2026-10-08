/**
 * src/meetings-recover/audio.ts
 *
 * I/O de áudio (ffmpeg) da transcrição pela gravação. Tudo num diretório
 * temporário por job, apagado no fim.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { speechSecondsFromSilencedetect } from './core.js';

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostats', '-y', ...args]);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += String(d); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg saiu com ${code}: ${stderr.slice(-300)}`))));
  });
}

export type RecordingFile = {
  /** Fala estimada (s) pelo detector de silêncio. */
  speechSeconds(durationS: number): Promise<number>;
  /** Pedaço em mp3 mono 16 kHz (o formato que a diarização recebe). */
  chunkMp3(startS: number, lenS: number): Promise<Buffer>;
  /** Amostra de voz em WAV mono 16 kHz (referência de falante). */
  clipWav(startS: number, lenS: number): Promise<Buffer>;
  dispose(): Promise<void>;
};

export async function openRecording(webm: Buffer): Promise<RecordingFile> {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-recover-'));
  const src = join(dir, 'rec.webm');
  await writeFile(src, webm);
  let n = 0;
  const tmp = (ext: string) => join(dir, `t${n++}.${ext}`);
  return {
    async speechSeconds(durationS) {
      const err = await run(['-i', src, '-af', 'silencedetect=noise=-40dB:d=1', '-f', 'null', '-']);
      return speechSecondsFromSilencedetect(err, durationS);
    },
    async chunkMp3(startS, lenS) {
      const out = tmp('mp3');
      await run(['-loglevel', 'error', '-ss', String(startS), '-t', String(lenS), '-i', src, '-ac', '1', '-ar', '16000', '-b:a', '32k', out]);
      return readFile(out);
    },
    async clipWav(startS, lenS) {
      const out = tmp('wav');
      await run(['-loglevel', 'error', '-ss', String(startS), '-t', String(lenS), '-i', src, '-ac', '1', '-ar', '16000', out]);
      return readFile(out);
    },
    async dispose() { await rm(dir, { recursive: true, force: true }); },
  };
}
