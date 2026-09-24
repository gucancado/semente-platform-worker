/**
 * src/cli/backfill-meeting-audio.ts
 *
 * Arquiva o áudio das reuniões gravadas ANTES do bucket da Vexa existir. Essas
 * gravações nunca chegaram ao MinIO (todo envio voltava 500 NoSuchBucket) e só
 * existem como arquivos soltos, copiados do /tmp do contêiner da Vexa. O nome
 * `recording_<id Vexa>_<sessão>.webm` liga cada arquivo ao episódio.
 *
 * Usa o MESMO `storeEpisodeAudio` do poller: remux, R2 e chave no episódio.
 *
 * Uso (dentro do contêiner do worker):
 *   node dist/cli/backfill-meeting-audio.js --dir=/tmp/vexa-recordings --dry-run
 *   node dist/cli/backfill-meeting-audio.js --dir=/tmp/vexa-recordings
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pool } from '../db.js';
import { putAndVerify, r2Configured } from '../integrations/r2.js';
import { parseRecordingFilename } from '../meetings-audio/core.js';
import { findEpisodeForVexaMeeting, setEpisodeAudioKey } from '../meetings-audio/db.js';
import { remuxWebm } from '../meetings-audio/remux.js';
import { storeEpisodeAudio } from '../meetings-audio/service.js';

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
}

async function main(): Promise<void> {
  const dir = flag('dir');
  const dryRun = flag('dry-run') !== undefined;
  if (!dir) throw new Error('--dir=<pasta com recording_*.webm> é obrigatório');
  if (!dryRun && !r2Configured()) throw new Error('R2 não configurado');

  const report = { files: 0, stored: 0, already: 0, no_episode: 0, bad_name: 0, failed: [] as string[] };
  for (const name of (await readdir(dir)).sort()) {
    const vexaId = parseRecordingFilename(name);
    if (vexaId == null) { report.bad_name += 1; continue; }
    report.files += 1;
    // Sala vazia, sala muda e bot recusado também geram arquivo; só vale o que virou episódio.
    const ep = await findEpisodeForVexaMeeting(pool, vexaId);
    if (!ep) { report.no_episode += 1; continue; }
    if (ep.hasAudio) { report.already += 1; continue; }
    if (dryRun) { console.log(`[dry-run] ${name} → episódio ${ep.episodeId}`); report.stored += 1; continue; }
    try {
      const r = await storeEpisodeAudio(
        {
          remux: (b) => remuxWebm(b),
          put: (key, body, ct) => putAndVerify(key, body, ct),
          setKey: (episodeId, key) => setEpisodeAudioKey(pool, episodeId, key),
        },
        { episodeId: ep.episodeId, vexaMeetingId: vexaId, bytes: await readFile(join(dir, name)), episodeDurationS: ep.durationS },
      );
      if (r.tooShort) { report.failed.push(`${name}: áudio curto demais (${r.durationS}s de ${ep.durationS}s)`); continue; }
      console.log(`${name} → episódio ${ep.episodeId} (${r.key}, ${r.bytes} bytes${r.repaired ? ', cabeçalho reparado' : ''})`);
      report.stored += 1;
    } catch (err) {
      report.failed.push(`${name}: ${(err as Error).message}`);
    }
  }
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
