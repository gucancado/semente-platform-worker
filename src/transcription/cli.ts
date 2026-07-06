import {
  pool,
  claimDueTranscriptionJobs,
  selectPendingTranscriptionJobs,
  getTranscriptionJobByMessageId,
} from '../db.js';
import { getBase64FromMediaMessage } from '../evolution/client.js';
import { getObjectBuffer, whatsappMediaBucket } from '../integrations/r2.js';
import { buildProcessDeps } from './runtime.js';
import { processJob } from './service.js';

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const deps = buildProcessDeps();

  if (cmd === 'pending') {
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 20;
    const dry = args.includes('--dry-run');
    // dry-run usa SELECT não-claiming (não consome attempts / não adia scheduled_at);
    // run normal claima (bumpa attempts + empurra scheduled_at, auto-cura de crash).
    const jobs = dry ? await selectPendingTranscriptionJobs(limit) : await claimDueTranscriptionJobs(limit);
    let total = 0;
    for (const job of jobs) {
      if (dry) {
        const media = await getBase64FromMediaMessage(deps.evolution, job.instance, job.raw_envelope);
        const buf = Buffer.from(media.base64 || '', 'base64');
        const { rows } = await pool.query(`SELECT media_duration_s, media_mime FROM messages WHERE id=$1`, [job.message_id]);
        const t = await deps.provider.transcribe(buf, { mime: rows[0]?.media_mime ?? 'audio/ogg', durationS: rows[0]?.media_duration_s ?? null });
        total += t.costUsd;
        console.log(`[dry] msg=${job.message_id} dur=${rows[0]?.media_duration_s}s custo=$${t.costUsd.toFixed(4)} :: ${t.text.slice(0, 80)}`);
      } else {
        await processJob(deps, job);
        const { rows } = await pool.query(`SELECT transcription_status, text FROM messages WHERE id=$1`, [job.message_id]);
        console.log(`msg=${job.message_id} status=${rows[0]?.transcription_status} :: ${(rows[0]?.text ?? '').slice(0, 80)}`);
      }
    }
    console.log(dry ? `TOTAL estimado: $${total.toFixed(4)} (${jobs.length} jobs)` : `Processados: ${jobs.length}`);
  } else if (cmd === 'redo') {
    const midIdx = args.indexOf('--message-id');
    const messageId = midIdx >= 0 ? Number(args[midIdx + 1]) : NaN;
    if (!messageId || Number.isNaN(messageId)) {
      console.error('uso: transcribe redo --message-id N');
      process.exit(1);
    }
    const { rows } = await pool.query(`SELECT media_key, media_mime, media_duration_s FROM messages WHERE id=$1`, [messageId]);
    const msg = rows[0];
    if (!msg?.media_key) { console.error('mensagem sem media_key — nada pra reprocessar do R2'); process.exit(1); }
    const job = await getTranscriptionJobByMessageId(messageId);
    if (job) console.log(`job encontrado: id=${job.id} status=${job.status} attempts=${job.attempts}`);
    const buf = await getObjectBuffer(msg.media_key, whatsappMediaBucket()!);
    const t = await deps.provider.transcribe(buf, { mime: msg.media_mime ?? 'audio/ogg', durationS: msg.media_duration_s });
    await pool.query(`UPDATE messages SET text=$2, transcription_status='done' WHERE id=$1`, [messageId, t.text.trim() || '[áudio sem fala reconhecível]']);
    console.log(`redo msg=${messageId} :: ${t.text.slice(0, 120)}`);
  } else {
    console.error('uso: transcribe pending [--limit N] [--dry-run] | transcribe redo --message-id N');
    process.exit(1);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
