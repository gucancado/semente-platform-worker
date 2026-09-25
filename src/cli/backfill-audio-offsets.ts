/**
 * src/cli/backfill-audio-offsets.ts
 *
 * Preenche, nos episódios da Vexa que já têm áudio, os dois números que o player
 * usa pra achar cada fala dentro do áudio (ver `audioOffsetMs` em meetings-read/db):
 *   - `first_segment_offset_ms`: 1ª fala − início da reunião, lido do JSON bruto no R2;
 *   - `audio_start_ms` (só com --dir): onde o áudio guardado começa na gravação
 *     original, medido no arquivo original reparado. 0 no arquivo inteiro.
 *
 * Uso (dentro do contêiner do worker):
 *   node dist/cli/backfill-audio-offsets.js
 *   node dist/cli/backfill-audio-offsets.js --dir=/tmp/vexa-recordings
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pool } from '../db.js';
import { getObjectBuffer } from '../integrations/r2.js';
import { parseVexaTimestamp } from '../integrations/vexa/normalize.js';
import { parseRecordingFilename, repairHeaderlessWebm } from '../meetings-audio/core.js';
import { findEpisodeForVexaMeeting } from '../meetings-audio/db.js';
import { probeStartS } from '../meetings-audio/remux.js';

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
}

async function setMeta(episodeId: number, patch: Record<string, number>): Promise<void> {
  await pool.query('UPDATE episodes SET metadata = metadata || $2::jsonb WHERE id = $1', [episodeId, JSON.stringify(patch)]);
}

async function main(): Promise<void> {
  const report = { offsets: 0, offset_missing: 0, starts: 0, failed: [] as string[] };
  const { rows } = await pool.query(
    `SELECT id, raw_r2_key FROM episodes
      WHERE external_source = 'vexa' AND audio_r2_key IS NOT NULL
        AND NOT (metadata ? 'first_segment_offset_ms')`);
  for (const r of rows) {
    try {
      if (!r.raw_r2_key) { report.offset_missing += 1; continue; }
      const raw = JSON.parse((await getObjectBuffer(r.raw_r2_key)).toString());
      const segs: Array<{ start: number }> = raw.segments ?? [];
      const st = parseVexaTimestamp(raw.start_time);
      if (!st || segs.length === 0) { report.offset_missing += 1; continue; }
      const first = Math.min(...segs.map((s) => s.start));
      await setMeta(Number(r.id), { first_segment_offset_ms: Math.max(0, Math.round(first * 1000 - st.getTime())) });
      report.offsets += 1;
    } catch (err) {
      report.failed.push(`${r.id}: ${(err as Error).message}`);
    }
  }
  const dir = flag('dir');
  if (dir) {
    for (const name of (await readdir(dir)).sort()) {
      const vid = parseRecordingFilename(name);
      if (vid == null) continue;
      const ep = await findEpisodeForVexaMeeting(pool, vid);
      if (!ep || !ep.hasAudio) continue;
      try {
        const { bytes } = repairHeaderlessWebm(await readFile(join(dir, name)));
        const startS = await probeStartS(bytes);
        await setMeta(ep.episodeId, { audio_start_ms: Math.max(0, Math.round((startS ?? 0) * 1000)) });
        report.starts += 1;
      } catch (err) {
        report.failed.push(`${name}: ${(err as Error).message}`);
      }
    }
  }
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
