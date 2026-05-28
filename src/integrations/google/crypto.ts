import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;   // GCM standard
const TAG_LEN = 16;  // GCM auth tag

/**
 * Encrypts plaintext using AES-256-GCM. Output format:
 *   IV (12 bytes) || ciphertext (N bytes) || authTag (16 bytes)
 *
 * Caller deve persistir o blob inteiro em BYTEA — decrypt reconstrói os 3 segmentos.
 */
export function encrypt(plaintext: string, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('encrypt: key must be 32 bytes (AES-256)');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

export function decrypt(blob: Buffer, key: Buffer): string {
  if (key.length !== 32) throw new Error('decrypt: key must be 32 bytes (AES-256)');
  if (blob.length < IV_LEN + TAG_LEN + 1) throw new Error('decrypt: blob too short');
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(IV_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

let cachedKey: Buffer | null = null;

/**
 * Lê GOOGLE_TOKEN_ENCRYPTION_KEY (base64) → Buffer 32 bytes. Cacheia em mem.
 * Lança se ausente ou tamanho errado — falha cedo no startup.
 */
export function loadEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error('GOOGLE_TOKEN_ENCRYPTION_KEY not configured');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(`GOOGLE_TOKEN_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length})`);
  }
  cachedKey = buf;
  return buf;
}

/** Pra tests resetarem o cache entre cenários. */
export function _resetKeyCacheForTests(): void {
  cachedKey = null;
}
