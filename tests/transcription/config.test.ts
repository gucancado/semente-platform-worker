import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTranscribeConfig } from '../../src/config.js';

test('mode=off nunca exige nada', () => {
  assert.doesNotThrow(() => assertTranscribeConfig({ TRANSCRIBE_MODE: 'off', OPENAI_API_KEY: undefined } as any, false));
});
test('mode=manual sem OPENAI_API_KEY falha', () => {
  assert.throws(() => assertTranscribeConfig({ TRANSCRIBE_MODE: 'manual', OPENAI_API_KEY: undefined } as any, true), /OPENAI_API_KEY/);
});
test('mode=auto sem R2 falha', () => {
  assert.throws(() => assertTranscribeConfig({ TRANSCRIBE_MODE: 'auto', OPENAI_API_KEY: 'k' } as any, false), /R2/);
});
test('mode=manual com tudo presente passa', () => {
  assert.doesNotThrow(() => assertTranscribeConfig({ TRANSCRIBE_MODE: 'manual', OPENAI_API_KEY: 'k' } as any, true));
});
