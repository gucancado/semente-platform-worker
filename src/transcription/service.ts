import type { Pool } from 'pg';
import type { EvolutionDeps } from '../evolution/client.js';
import { getBase64FromMediaMessage } from '../evolution/client.js';
import { getNumber } from '../whatsapp/numbers.js';
import { agentsToTrigger } from '../whatsapp/reaction.js';
import { computeScheduledAt } from '../triggers/quiet-hours.js';
import {
  enqueuePendingTrigger, insertLlmMetric, markTranscriptionDone, markTranscriptionRetryOrFail,
  type TranscriptionJob,
} from '../db.js';
import type { TranscriptionProvider } from './provider.js';

export type ProcessDeps = {
  pool: Pool;
  evolution: EvolutionDeps;
  provider: TranscriptionProvider;
  mode: 'off' | 'manual' | 'auto';
  maxAttempts: number;
  maxDurationS: number;
  debounceMs: number;
  r2: {
    putAndVerify: (key: string, body: Buffer, ct: string, bucket?: string) => Promise<void>;
    getObjectBuffer: (key: string, bucket?: string) => Promise<Buffer>;
    presignGet: (key: string, ttl?: number, bucket?: string) => Promise<string>;
    bucket: string;
  };
  log?: { warn: (o: any, m?: string) => void; info: (o: any, m?: string) => void };
};

async function updateMsg(pool: Pool, id: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(`UPDATE messages SET ${set} WHERE id = $1`, [id, ...keys.map(k => fields[k])]);
}

async function maybeTrigger(deps: ProcessDeps, job: TranscriptionJob) {
  if (deps.mode !== 'auto' || job.direction !== 'inbound' || job.is_group) return;
  const num = await getNumber(deps.pool, job.whatsapp_number_id);
  if (!num || !job.workspace_id) return;
  const agents = await agentsToTrigger(deps.pool, { workspaceId: job.workspace_id, numberId: job.whatsapp_number_id, mode: num.mode });
  for (const agent of agents) {
    const scheduledAt = computeScheduledAt(null, deps.debounceMs);
    await enqueuePendingTrigger({ agent, project: null, identifier: job.identifier, inbox_id: job.inbox_id ?? 0, scheduled_at: scheduledAt });
  }
}

/** Processa 1 job já claimado (attempts bumpado pelo claim). */
export async function processJob(deps: ProcessDeps, job: TranscriptionJob): Promise<void> {
  const { pool } = deps;
  const { rows } = await pool.query<{ media_duration_s: number | null; media_mime: string | null; workspace_id: string | null }>(
    `SELECT media_duration_s, media_mime, workspace_id FROM messages WHERE id = $1`, [job.message_id]);
  const msg = rows[0];
  const durationS = msg?.media_duration_s ?? null;
  const mime = msg?.media_mime ?? 'audio/ogg';
  const key = `whatsapp-audio/${job.workspace_id ?? 'na'}/${job.whatsapp_number_id}/${job.message_id}.ogg`;

  try {
    // 1) download — base64 vazio é retryable (mídia ainda não descriptografada)
    const media = await getBase64FromMediaMessage(deps.evolution, job.instance, job.raw_envelope);
    if (!media.base64) throw new Error('evolution base64 vazio (mídia não pronta)');

    // 2) cap de duração — sobe o .ogg (pra ouvir) mas não transcreve
    const buf = Buffer.from(media.base64, 'base64');
    if (durationS && durationS > deps.maxDurationS) {
      await deps.r2.putAndVerify(key, buf, mime, deps.r2.bucket);
      await updateMsg(pool, job.message_id, { media_key: key, media_mime: mime, transcription_status: 'failed', text: '[áudio longo — não transcrito]' });
      await markTranscriptionDone(job.id); // terminal (não retry): usa done p/ tirar da fila; status da msg = failed
      return;
    }

    // 3) upload + grava media_key ANTES do ASR (falha do ASR ainda deixa áudio ouvível)
    await deps.r2.putAndVerify(key, buf, mime, deps.r2.bucket);
    await updateMsg(pool, job.message_id, { media_key: key, media_mime: mime });

    // 4) transcreve
    const t = await deps.provider.transcribe(buf, { mime: media.mimetype ?? mime, durationS });
    const text = t.text.trim() || '[áudio sem fala reconhecível]';

    // 5) grava transcrição + custo + done (transação)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE messages SET text=$2, transcription_status='done' WHERE id=$1`, [job.message_id, text]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await insertLlmMetric({ agent: 'transcription', message_id: job.message_id, task: 'transcribe', provider: 'openai', model: t.model, cost_usd: t.costUsd });
    await markTranscriptionDone(job.id);

    // 6) trigger (só auto+inbound+não-grupo)
    await maybeTrigger(deps, job);
  } catch (err) {
    const msgErr = (err as Error).message;
    const res = await markTranscriptionRetryOrFail(job.id, job.attempts, deps.maxAttempts, msgErr);
    deps.log?.warn({ jobId: job.id, err: msgErr, retried: res.retried }, 'transcription job falhou');
    if (!res.retried) {
      await updateMsg(pool, job.message_id, { transcription_status: 'failed', text: '[áudio — transcrição indisponível]' });
      await maybeTrigger(deps, job); // não travar o lead
    }
  }
}
