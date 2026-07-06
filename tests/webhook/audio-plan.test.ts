import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioIngestPlan } from '../../src/webhook/routes.js';

test('off nunca captura', () => assert.deepEqual(audioIngestPlan('off', false, true), { capture: false, suppressTrigger: false }));
test('grupo nunca captura', () => assert.deepEqual(audioIngestPlan('manual', true, true), { capture: false, suppressTrigger: false }));
test('sem áudio não captura', () => assert.deepEqual(audioIngestPlan('auto', false, false), { capture: false, suppressTrigger: false }));
test('manual captura, não suprime trigger', () => assert.deepEqual(audioIngestPlan('manual', false, true), { capture: true, suppressTrigger: false }));
test('auto captura e suprime trigger', () => assert.deepEqual(audioIngestPlan('auto', false, true), { capture: true, suppressTrigger: true }));
