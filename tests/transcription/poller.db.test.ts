import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, insertMessage, insertTranscriptionJob, claimDueTranscriptionJobs } from '../../src/db.js';
import { runTranscriptionBatch } from '../../src/transcription/poller.js';

const R2_MOCK = { putAndVerify: async () => {}, getObjectBuffer: async () => Buffer.from('x'), presignGet: async () => 'url', bucket: 'b' };
const okProvider = { transcribe: async () => ({ text: 'ok', model: 'gpt-4o-mini-transcribe', costUsd: 0.001 }) };
const evo = { baseUrl: 'http://e', apiKey: 'k', fetch: (async () => ({ ok: true, json: async () => ({ base64: 'QUJD', mimetype: 'audio/ogg' }) })) as any };

beforeEach(async () => {
  await pool.query('TRUNCATE transcription_jobs, messages, llm_metrics, whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance, mode) VALUES (1,'ws-1','inst-1','monitored')`);
});
after(() => pool.end());

test('runTranscriptionBatch processa jobs pendentes', async () => {
  const m = await insertMessage({ agent: null, channel: 'whatsapp', identifier: '+55a', direction: 'inbound', text: '[áudio]', evolution_event_id: 'E1', whatsapp_number_id: 1, workspace_id: 'ws-1', kind: 'audio', media_mime: 'audio/ogg', media_duration_s: 3, transcription_status: 'pending' });
  await insertTranscriptionJob({ message_id: m.id, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: 'inbound', is_group: false, identifier: '+55a', inbox_id: 1, raw_envelope: {} });
  const deps = { pool, evolution: evo, provider: okProvider, mode: 'auto', maxAttempts: 4, maxDurationS: 600, debounceMs: 25000, r2: R2_MOCK } as any;
  const n = await runTranscriptionBatch(deps, 10);
  assert.equal(n, 1);
  const { rows } = await pool.query(`SELECT transcription_status FROM messages WHERE id=$1`, [m.id]);
  assert.equal(rows[0].transcription_status, 'done');
});
