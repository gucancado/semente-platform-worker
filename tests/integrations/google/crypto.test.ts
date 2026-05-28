import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, loadEncryptionKey, _resetKeyCacheForTests } from '../../../src/integrations/google/crypto.js';

const key = randomBytes(32);

beforeEach(() => {
  _resetKeyCacheForTests();
  delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
});

test('encrypt/decrypt: round-trip', () => {
  const pt = 'refresh-token-value-1//xyzABC';
  const blob = encrypt(pt, key);
  assert.equal(decrypt(blob, key), pt);
});

test('encrypt: blob includes IV + ciphertext + auth tag', () => {
  const pt = 'short';
  const blob = encrypt(pt, key);
  // IV (12) + ct (5) + tag (16) = 33
  assert.equal(blob.length, 12 + 5 + 16);
});

test('decrypt: tampered ciphertext throws', () => {
  const pt = 'sensitive';
  const blob = encrypt(pt, key);
  // Flip 1 bit no meio
  blob[20] = blob[20]! ^ 0xff;
  assert.throws(() => decrypt(blob, key));
});

test('encrypt: rejects key with wrong length', () => {
  const wrongKey = randomBytes(16);
  assert.throws(() => encrypt('x', wrongKey), /32 bytes/);
});

test('loadEncryptionKey: reads from env base64', () => {
  const raw = randomBytes(32).toString('base64');
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = raw;
  const k = loadEncryptionKey();
  assert.equal(k.length, 32);
});

test('loadEncryptionKey: throws when env missing', () => {
  assert.throws(() => loadEncryptionKey(), /not configured/);
});

test('loadEncryptionKey: throws on wrong length', () => {
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.from('only-16-bytes!!!').toString('base64');
  assert.throws(() => loadEncryptionKey(), /32 bytes/);
});

test('loadEncryptionKey: caches result between calls', () => {
  const raw = randomBytes(32).toString('base64');
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = raw;
  const a = loadEncryptionKey();
  const b = loadEncryptionKey();
  assert.equal(a, b); // same buffer reference
});
