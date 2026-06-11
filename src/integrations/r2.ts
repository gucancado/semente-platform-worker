import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
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

/** Upload com key determinística + verificação por HEAD (content-length). Retry sobrescreve o mesmo objeto. */
export async function putAndVerify(key: string, body: Buffer | string, contentType: string): Promise<void> {
  const c = client();
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  await c.send(new PutObjectCommand({ Bucket: config.R2_BUCKET_EPISODES!, Key: key, Body: buf, ContentType: contentType }));
  const head = await c.send(new HeadObjectCommand({ Bucket: config.R2_BUCKET_EPISODES!, Key: key }));
  if (head.ContentLength !== buf.length) {
    throw new Error(`r2: verificação falhou pra ${key} (esperado ${buf.length}, gravado ${head.ContentLength})`);
  }
}
