/**
 * src/whatsapp/media-policy.ts
 *
 * Decisões da mídia do WhatsApp além de áudio. PURO (sem pg, sem env, sem rede):
 * o ingest, o poller, a expiração e o CLI de uso só aplicam o que sai daqui.
 *
 * Números que sustentam os defaults (medidos na Evolution em 2026-09-15, 692
 * mídias de 20 instâncias): imagem p50 95 KB; documento p50 76 KB mas p99 80 MB e
 * máximo 114 MB. **1,6% dos arquivos concentram 83,5% dos bytes** — por isso o
 * teto por arquivo é a trava principal, e não cota por workspace.
 */
import type { MediaKind, ParsedMedia } from '../webhook/evolution.js';

export type MediaStatus = 'pending' | 'stored' | 'skipped_size' | 'skipped_policy' | 'failed' | 'expired';
export type DownloadableKind = 'image' | 'video' | 'document';
export const DOWNLOADABLE_KINDS: readonly DownloadableKind[] = ['image', 'video', 'document'];

// ── Ingest ────────────────────────────────────────────────────────────────────

export interface MediaIngestInput {
  mode: 'off' | 'on';
  isGroup: boolean;
  media: ParsedMedia | null;
  maxBytes: number;
  kinds: readonly DownloadableKind[];
}

export type MediaIngestPlan =
  | { record: false }
  | { record: true; status: 'pending' | 'skipped_size' | 'skipped_policy' };

/**
 * `record` = gravar a mensagem com marcador. `status` = o que acontece com o ARQUIVO.
 *
 * Modo 'off' devolve record=false para tudo: o ingest segue byte-idêntico ao de
 * antes desta feature. Grupo fica de fora pelo mesmo motivo do áudio — os grupos
 * internos virariam o maior consumidor sem ganho comercial. Áudio tem trilho
 * próprio (transcrição) e nunca passa por aqui.
 *
 * Tamanho declarado AUSENTE não recusa: o teto é conferido de novo no arquivo
 * real, depois do download (media-service).
 */
export function mediaIngestPlan(i: MediaIngestInput): MediaIngestPlan {
  if (i.mode !== 'on' || i.isGroup || !i.media || i.media.kind === 'audio') return { record: false };
  const kind = i.media.kind;
  if (kind === 'sticker' || !(i.kinds as readonly string[]).includes(kind)) {
    return { record: true, status: 'skipped_policy' };
  }
  if (i.media.sizeBytes != null && i.media.sizeBytes > i.maxBytes) {
    return { record: true, status: 'skipped_size' };
  }
  return { record: true, status: 'pending' };
}

const LABEL: Record<Exclude<MediaKind, 'audio'>, string> = {
  image: 'imagem',
  video: 'vídeo',
  document: 'documento',
  sticker: 'figurinha',
};

/** Nome de arquivo vem do cliente: sem controle, sem colchete (quebraria o
 *  marcador que o painel remove), com teto de tamanho. */
export function cleanFilename(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

/**
 * Texto de uma mensagem de mídia. `messages.text` é NOT NULL e é o que o motor
 * de IA, o export e a busca leem: o marcador diz QUE veio um arquivo (o atendente
 * mandou fotos, o cliente mandou comprovante) e a legenda vem depois dele.
 * O painel remove o marcador ao desenhar a bolha (ele já mostra o arquivo).
 */
export function mediaMessageText(media: ParsedMedia, caption: string | null): string {
  const label = media.kind === 'audio' ? 'áudio' : LABEL[media.kind];
  const name = media.kind === 'document' ? cleanFilename(media.filename) : null;
  const marker = name ? `[${label}: ${name}]` : `[${label}]`;
  const cap = caption?.trim();
  return cap ? `${marker} ${cap}` : marker;
}

// ── Armazenamento ────────────────────────────────────────────────────────────

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

export function mediaExtension(mime: string | null, filename: string | null): string {
  const base = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  const known = EXT_BY_MIME[base];
  if (known) return known;
  const fromName = filename?.match(/\.([a-z0-9]{1,8})$/i)?.[1];
  return fromName ? fromName.toLowerCase() : 'bin';
}

/**
 * Key por MENSAGEM, nunca pelo nome do arquivo — o nome vem do cliente (path
 * traversal, unicode, colisão). O prefixo `whatsapp-media/` é o que a expiração e
 * o CLI de uso contabilizam, ao lado do `whatsapp-audio/` do trilho de transcrição.
 */
export function mediaObjectKey(p: { workspaceId: string | null; numberId: number; messageId: number; ext: string }): string {
  return `whatsapp-media/${p.workspaceId ?? 'na'}/${p.numberId}/${p.messageId}.${p.ext}`;
}

/** Prefixos do R2 que pertencem à mídia do WhatsApp (uso + expiração). */
export const WHATSAPP_MEDIA_PREFIXES = ['whatsapp-media/', 'whatsapp-audio/'] as const;

/**
 * Content-Disposition do presign. Só documento baixa como anexo, com o nome
 * original: sem isso o arquivo chega ao usuário como `48213.pdf`. Imagem e vídeo
 * ficam inline (são desenhados na própria conversa).
 */
export function contentDisposition(kind: string, filename: string | null): string | undefined {
  if (kind !== 'document') return undefined;
  const name = cleanFilename(filename) ?? 'documento';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ── Falha e retentativa ──────────────────────────────────────────────────────

export type MediaErrorClass = 'systemic' | 'item';

/** Falha do AMBIENTE não consome tentativa; 15 min é longo de propósito. */
export const MEDIA_SYSTEMIC_BACKOFF_SEC = 900;
/** Teto de idade do caso sistêmico: passou disto, desiste de vez. */
export const MEDIA_SYSTEMIC_MAX_AGE_H = 72;

function isSystemicStatus(n: number): boolean {
  return n === 401 || n === 403 || n === 429 || n >= 500;
}

/**
 * A culpa é do ambiente (Evolution ou R2 fora, chave errada) ou deste arquivo?
 *
 * Pelo STATUS ESTRUTURADO, não por substring. O classificador da transcrição
 * procura '500' em qualquer ponto da mensagem — aqui isso quebraria, porque o erro
 * da Evolution carrega o nome da instância no path (`ws-0d5acf34-f36b7aa4`) e hex
 * contém "500", "401", "503"... por acaso. Um 400 viraria sistêmico e giraria 72h.
 */
export function classifyMediaError(err: unknown): MediaErrorClass {
  const e = (err ?? {}) as {
    message?: unknown;
    name?: unknown;
    code?: unknown;
    cause?: { code?: unknown };
    $metadata?: { httpStatusCode?: unknown };
  };
  const http = e.$metadata?.httpStatusCode;
  if (typeof http === 'number') return isSystemicStatus(http) ? 'systemic' : 'item';
  const message = typeof e.message === 'string' ? e.message : String(err ?? '');
  // Formato do call() de src/evolution/client.ts: "Evolution POST /path → 503".
  const status = message.match(/→ (\d{3})\s*$/)?.[1];
  if (status) return isSystemicStatus(Number(status)) ? 'systemic' : 'item';
  const hay = `${message} ${String(e.name ?? '')} ${String(e.code ?? '')} ${String(e.cause?.code ?? '')}`.toLowerCase();
  return /fetch failed|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|timeouterror|aborterror/.test(hay)
    ? 'systemic'
    : 'item';
}

export interface MediaRetryPlan {
  action: 'retry' | 'fail';
  backoffSec: number;
  /** false = devolver a tentativa que o claim já somou (caso sistêmico). */
  consumesAttempt: boolean;
}

export function planMediaRetry(i: { cls: MediaErrorClass; attempts: number; maxAttempts: number; ageH: number }): MediaRetryPlan {
  if (i.cls === 'systemic') {
    if (i.ageH > MEDIA_SYSTEMIC_MAX_AGE_H) return { action: 'fail', backoffSec: 0, consumesAttempt: false };
    return { action: 'retry', backoffSec: MEDIA_SYSTEMIC_BACKOFF_SEC, consumesAttempt: false };
  }
  if (i.attempts >= i.maxAttempts) return { action: 'fail', backoffSec: 0, consumesAttempt: true };
  return { action: 'retry', backoffSec: Math.min(i.attempts * 60, 900), consumesAttempt: true };
}

// ── Expiração e orçamento ────────────────────────────────────────────────────

/**
 * Piso da expiração. 0 = desligada (estado de produção, por decisão do owner em
 * 2026-09-16); qualquer valor de 1 a 29 é RECUSADO — um typo como `1` no lugar
 * de `180` apagaria quase todo arquivo guardado numa única varredura.
 */
export const MIN_RETENTION_DAYS = 30;

export function retentionEnabled(days: number): boolean {
  return Number.isInteger(days) && days >= MIN_RETENTION_DAYS;
}

/**
 * Regra do owner (2026-09-16): a limpeza e a ativação da expiração de 180 dias só
 * acontecem com aprovação dele, quando o uso passar de 70% do orçamento.
 */
export const STORAGE_REVIEW_THRESHOLD = 0.7;

export function storageVerdict(usedBytes: number, budgetGb: number): { pct: number; overThreshold: boolean } {
  const budgetBytes = budgetGb * 1024 ** 3;
  const pct = budgetBytes > 0 ? usedBytes / budgetBytes : 0;
  return { pct, overThreshold: pct > STORAGE_REVIEW_THRESHOLD };
}
