/**
 * src/meetings-audio/remux.ts
 *
 * O webm que o bot grava (MediaRecorder do Chromium, montado a partir de pedaços)
 * NÃO declara duração nem índice de busca: `ffprobe` responde `Duration: N/A`.
 * No navegador isso vira `duration = Infinity` e a barra de navegação do player
 * não funciona. Uma cópia sem recodificar (`-c copy`) pelo ffmpeg escreve os dois
 * e leva uma fração de segundo (medido: 11min33s, 5,5 MB, mesmo tamanho).
 *
 * A saída vai pra ARQUIVO, não pra pipe: o muxer webm precisa voltar ao começo do
 * arquivo pra gravar duração e índice, e num pipe ele não consegue.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `startS`: onde o áudio começa na linha do tempo ORIGINAL da gravação. É 0 no
 * arquivo inteiro; na gravação reparada (o bot perdeu o 1º pedaço) é o tempo que
 * sumiu, e a saída do remux passa a contar do zero a partir dali. O player soma
 * esse deslocamento pra achar cada fala no áudio.
 */
export type Remuxed = { bytes: Buffer; durationS: number | null; startS: number | null };

export async function remuxWebm(input: Buffer, ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe'): Promise<Remuxed> {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-audio-'));
  const inPath = join(dir, 'in.webm');
  const outPath = join(dir, 'out.webm');
  try {
    await writeFile(inPath, input);
    const startS = await probeFormat(inPath, 'start_time', ffprobePath);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', inPath, '-c', 'copy', outPath]);
      let stderr = '';
      p.stderr.on('data', (d) => { stderr += String(d); });
      p.on('error', reject);
      p.on('close', (code) => {
        // O arquivo do bot termina num cluster incompleto e o ffmpeg avisa
        // "File ended prematurely" mesmo com loglevel error. É aviso: o código de
        // saída é 0 e a saída sai correta. Falha é só código != 0.
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg saiu com ${code}: ${stderr.slice(0, 300)}`));
      });
    });
    const out = await readFile(outPath);
    if (out.length === 0) throw new Error('ffmpeg gerou arquivo vazio');
    return { bytes: out, durationS: await probeFormat(outPath, 'duration', ffprobePath), startS };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Campo de formato do ffprobe em segundos (`duration`, `start_time`). `null` quando
 *  o ffprobe não consegue ler — o chamador trata como áudio inválido. */
async function probeFormat(path: string, field: 'duration' | 'start_time', ffprobePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(ffprobePath, ['-v', 'error', '-show_entries', `format=${field}`, '-of', 'csv=p=0', path]);
    let out = '';
    p.stdout.on('data', (d) => { out += String(d); });
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      const v = Number(out.trim());
      resolve(code === 0 && Number.isFinite(v) ? v : null);
    });
  });
}

/** Só o início na linha do tempo original (`start_time`), sem remux. Usado pra
 *  preencher `audio_start_ms` de áudio já guardado a partir do arquivo original. */
export async function probeStartS(input: Buffer, ffprobePath = 'ffprobe'): Promise<number | null> {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-audio-'));
  try {
    const p = join(dir, 'in.webm');
    await writeFile(p, input);
    return await probeFormat(p, 'start_time', ffprobePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
