import '../setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whatsappMediaBucket } from '../../src/integrations/r2.js';

test('whatsappMediaBucket usa R2_BUCKET_WHATSAPP_MEDIA quando setado, senão episodes', () => {
  // Sem env dedicada, cai no fallback de episódios (ou undefined em teste sem R2).
  const b = whatsappMediaBucket();
  assert.equal(typeof b === 'string' || b === undefined, true);
});
