/**
 * src/whatsapp/media-service.ts
 *
 * Processa UM job de download de mídia (imagem, vídeo, documento) já claimado:
 * baixa da Evolution, confere o teto no arquivo REAL, sobe pro R2 e grava a key.
 * Sem env nem rede próprios — `io` e `pool` são injetados (o poller monta os reais).
 *
 * Sem transação, de propósito, e seguro por ORDEM: a mensagem é atualizada antes
 * do job ser marcado `done`. Se o processo morrer entre as duas escritas, o job
 * volta à fila e o primeiro passo daqui vê que a mensagem já está resolvida — não
 * baixa de novo nem grava um segundo objeto.
 */
import type { Pool } from 'pg';
import {
  classifyMediaError,
  mediaExtension,
  mediaObjectKey,
  planMediaRetry,
  type MediaStatus,
} from './media-policy.js';
import {
  applyWhatsappMediaRetry,
  markWhatsappMediaJobDone,
  type WhatsappMediaJob,
} from './media-jobs.js';

export type MediaIo = {
  download: (instance: string, envelope: unknown) => Promise<{ base64: string; mimetype: string | null }>;
  upload: (key: string, body: Buffer, contentType: string) => Promise<void>;
};

export type MediaProcessDeps = {
  pool: Pick<Pool, 'query'>;
  io: MediaIo;
  maxBytes: number;
  maxAttempts: number;
  now?: () => Date;
  /** Falha do AMBIENTE (não do arquivo): o poller usa pra abrir o disjuntor. */
  onSystemicFailure?: (error: string) => void;
  log?: { warn: (o: object, m?: string) => void };
};

export type MediaJobOutcome = 'stored' | 'skipped_size' | 'already_resolved' | 'retry' | 'failed';

/** Estados em que o arquivo já tem destino final e o job só precisa sair da fila. */
const RESOLVED: ReadonlySet<string> = new Set<MediaStatus>(['stored', 'skipped_size', 'skipped_policy', 'failed', 'expired']);

export async function processMediaJob(deps: MediaProcessDeps, job: WhatsappMediaJob): Promise<MediaJobOutcome> {
  const { pool } = deps;
  const { rows } = await pool.query<{ media_mime: string | null; media_filename: string | null; media_key: string | null; media_status: string | null }>(
    `SELECT media_mime, media_filename, media_key, media_status FROM messages WHERE id = $1`,
    [job.message_id],
  );
  const msg = rows[0];
  if (!msg || msg.media_key || (msg.media_status && RESOLVED.has(msg.media_status))) {
    await markWhatsappMediaJobDone(pool, job.id);
    return 'already_resolved';
  }

  try {
    const media = await deps.io.download(job.instance, job.raw_envelope);
    // base64 vazio = mídia ainda não descriptografada na Evolution; retentável.
    if (!media.base64) throw new Error('evolution base64 vazio (mídia não pronta)');
    const buf = Buffer.from(media.base64, 'base64');

    // O tamanho declarado no webhook pode faltar ou mentir: o teto vale pro arquivo real.
    if (buf.length > deps.maxBytes) {
      await pool.query(
        `UPDATE messages SET media_status = 'skipped_size', media_size_bytes = $2 WHERE id = $1`,
        [job.message_id, buf.length],
      );
      await markWhatsappMediaJobDone(pool, job.id);
      return 'skipped_size';
    }

    const mime = msg.media_mime ?? media.mimetype ?? 'application/octet-stream';
    const key = mediaObjectKey({
      workspaceId: job.workspace_id,
      numberId: Number(job.whatsapp_number_id),
      messageId: Number(job.message_id),
      ext: mediaExtension(mime, msg.media_filename),
    });
    await deps.io.upload(key, buf, mime);
    await pool.query(
      `UPDATE messages
          SET media_key = $2, media_mime = $3, media_size_bytes = $4, media_status = 'stored'
        WHERE id = $1`,
      [job.message_id, key, mime, buf.length],
    );
    await markWhatsappMediaJobDone(pool, job.id);
    return 'stored';
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const cls = classifyMediaError(err);
    const now = deps.now?.() ?? new Date();
    const ageH = (now.getTime() - new Date(job.created_at).getTime()) / 3_600_000;
    const plan = planMediaRetry({ cls, attempts: job.attempts, maxAttempts: deps.maxAttempts, ageH });
    await applyWhatsappMediaRetry(pool, job.id, plan, error);
    deps.log?.warn({ jobId: job.id, messageId: job.message_id, err: error, cls, action: plan.action }, 'whatsapp-media: download falhou');
    if (cls === 'systemic') deps.onSystemicFailure?.(error);
    if (plan.action === 'fail') {
      await pool.query(`UPDATE messages SET media_status = 'failed' WHERE id = $1`, [job.message_id]);
      return 'failed';
    }
    return 'retry';
  }
}
