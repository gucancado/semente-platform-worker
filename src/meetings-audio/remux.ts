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

export async function remuxWebm(input: Buffer, ffmpegPath = 'ffmpeg'): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-audio-'));
  const inPath = join(dir, 'in.webm');
  const outPath = join(dir, 'out.webm');
  try {
    await writeFile(inPath, input);
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
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
