import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

export function r2Configured(): boolean {
  return Boolean(config.R2_ENDPOINT && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY && config.R2_BUCKET_EPISODES);
}

let _client: S3Client | null = null;
function client(): S3Client {
  if (!_client) _client = new S3Client({
    region: 'auto',
    endpoint: config.R2_ENDPOINT!,
    credentials: { accessKeyId: config.R2_ACCESS_KEY_ID!, secretAccessKey: config.R2_SECRET_ACCESS_KEY! },
  });
  return _client;
}

/**
 * Bucket da mídia do WhatsApp. Em produção `R2_BUCKET_WHATSAPP_MEDIA` NÃO está
 * definida (conferido em 2026-09-15): tudo cai no bucket de episódios.
 *
 * Definir essa env sem antes copiar os objetos quebra o que já existe — a leitura
 * resolve o bucket na hora, então os 8 mil áudios já guardados passariam a apontar
 * pro bucket novo, vazio.
 */
export function whatsappMediaBucket(): string | undefined {
  return config.R2_BUCKET_WHATSAPP_MEDIA ?? config.R2_BUCKET_EPISODES;
}

/** Upload com key determinística + verificação por HEAD (content-length). Retry sobrescreve o mesmo objeto. */
export async function putAndVerify(key: string, body: Buffer | string, contentType: string, bucket = config.R2_BUCKET_EPISODES!): Promise<void> {
  const c = client();
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  await c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: contentType }));
  const head = await c.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (head.ContentLength !== buf.length) {
    throw new Error(`r2: verificação falhou pra ${key} (esperado ${buf.length}, gravado ${head.ContentLength})`);
  }
}

/**
 * URL GET presigned (TTL curto). Lança se R2 não configurado.
 * `contentDisposition` força download com o nome original (documentos).
 */
export async function presignGet(
  key: string,
  ttlSeconds = 120,
  bucket = config.R2_BUCKET_EPISODES!,
  opts?: { contentDisposition?: string },
): Promise<string> {
  if (!r2Configured()) throw new Error('r2: não configurado (R2_* ausentes)');
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: opts?.contentDisposition });
  return getSignedUrl(client(), cmd, { expiresIn: ttlSeconds });
}

/** Download de objeto como Buffer. */
export async function getObjectBuffer(key: string, bucket = config.R2_BUCKET_EPISODES!): Promise<Buffer> {
  const out = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await out.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

/** Apaga um objeto. Key inexistente é sucesso (semântica S3), então é idempotente. */
export async function deleteObject(key: string, bucket: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** Percorre todos os objetos sob um prefixo, de 1.000 em 1.000. */
export async function forEachObject(
  prefix: string,
  bucket: string,
  fn: (o: { key: string; size: number; lastModified: Date | null }) => void,
): Promise<void> {
  let token: string | undefined;
  do {
    const r = await client().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of r.Contents ?? []) fn({ key: o.Key ?? '', size: o.Size ?? 0, lastModified: o.LastModified ?? null });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
}
