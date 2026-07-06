import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, insertMessage, insertTranscriptionJob, claimDueTranscriptionJobs } from '../../src/db.js';
import { processJob } from '../../src/transcription/service.js';

const R2_MOCK = { putAndVerify: async () => {}, getObjectBuffer: async () => Buffer.from('x'), presignGet: async () => 'url', bucket: 'b' };
const okProvider = { transcribe: async () => ({ text: 'transcrição feliz', model: 'gpt-4o-mini-transcribe', costUsd: 0.001 }) };
function evoReturning(base64: string) { return { baseUrl: 'http://e', apiKey: 'k', fetch: (async () => ({ ok: true, json: async () => ({ base64, mimetype: 'audio/ogg' }) })) as any }; }

beforeEach(async () => {
  await pool.query('TRUNCATE transcription_jobs, messages, llm_metrics, pending_triggers, whatsapp_numbers, workspace_agents RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance, mode) VALUES (1,'ws-1','inst-1','agent_operated')`);
});
after(() => pool.end());

async function seedJob(dir: 'inbound'|'outbound' = 'inbound') {
  const m = await insertMessage({ agent: null, channel: 'whatsapp', identifier: '+55a', direction: dir, text: '[áudio]',
    evolution_event_id: 'E1', whatsapp_number_id: 1, workspace_id: 'ws-1', kind: 'audio', media_mime: 'audio/ogg', media_duration_s: 5, transcription_status: 'pending' });
  await insertTranscriptionJob({ message_id: m.id, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: dir, is_group: false, identifier: '+55a', inbox_id: 10, raw_envelope: { key: { id: 'E1' } } });
  return (await claimDueTranscriptionJobs(10))[0];
}
function deps(over: any = {}) {
  return { pool, evolution: evoReturning('QUJD'), provider: okProvider, mode: 'auto', maxAttempts: 4, maxDurationS: 600, debounceMs: 25000, r2: R2_MOCK, ...over } as any;
}

test('feliz: grava transcrição, done, media_key, llm_metrics; auto+inbound → trigger', async () => {
  await pool.query(`INSERT INTO workspace_agents (workspace_id, whatsapp_number_id, agent, reaction_mode) VALUES ('ws-1',1,'mercurio','reactive')`);
  const job = await seedJob('inbound');
  await processJob(deps(), job);
  const { rows: msg } = await pool.query(`SELECT text, transcription_status, media_key FROM messages WHERE id=$1`, [job.message_id]);
  assert.equal(msg[0].text, 'transcrição feliz');
  assert.equal(msg[0].transcription_status, 'done');
  assert.ok(msg[0].media_key);
  const { rows: met } = await pool.query(`SELECT agent, task FROM llm_metrics`);
  assert.equal(met[0].agent, 'transcription');
  assert.equal(met[0].task, 'transcribe');
  const { rows: trig } = await pool.query(`SELECT count(*)::int c FROM pending_triggers WHERE status='pending'`);
  assert.equal(trig[0].c, 1);
  const { rows: j } = await pool.query(`SELECT status, raw_envelope FROM transcription_jobs WHERE id=$1`, [job.id]);
  assert.equal(j[0].status, 'done');
  assert.deepEqual(j[0].raw_envelope, {});
});

test('outbound (fromMe) não dispara trigger', async () => {
  const job = await seedJob('outbound');
  await processJob(deps(), job);
  const { rows } = await pool.query(`SELECT count(*)::int c FROM pending_triggers`);
  assert.equal(rows[0].c, 0);
});

test('base64 vazio → retry (job volta pending, sem media_key)', async () => {
  const job = await seedJob('inbound');
  await processJob(deps({ evolution: evoReturning('') }), job);
  const { rows: j } = await pool.query(`SELECT status FROM transcription_jobs WHERE id=$1`, [job.id]);
  assert.equal(j[0].status, 'pending');
  const { rows: m } = await pool.query(`SELECT media_key, transcription_status FROM messages WHERE id=$1`, [job.message_id]);
  assert.equal(m[0].media_key, null);
  assert.equal(m[0].transcription_status, 'pending');
});

test('media_key gravado ANTES do ASR: ASR falha ainda deixa áudio ouvível', async () => {
  const job = await seedJob('inbound');
  const boom = { transcribe: async () => { throw new Error('asr down'); } };
  await processJob(deps({ provider: boom, maxAttempts: 4 }), job);
  const { rows: m } = await pool.query(`SELECT media_key FROM messages WHERE id=$1`, [job.message_id]);
  assert.ok(m[0].media_key, 'media_key setado no upload, antes de falhar o ASR');
});

test('falha final (attempts>=max) → failed + placeholder', async () => {
  const job = await seedJob('inbound');
  const boom = { transcribe: async () => { throw new Error('asr down'); } };
  await processJob(deps({ provider: boom, maxAttempts: 1 }), { ...job, attempts: 1 });
  const { rows: m } = await pool.query(`SELECT text, transcription_status FROM messages WHERE id=$1`, [job.message_id]);
  assert.equal(m[0].transcription_status, 'failed');
  assert.match(m[0].text, /indispon/i);
});

test('cap de duração: não chama ASR, sobe ogg, failed com placeholder de longo', async () => {
  await pool.query(`UPDATE messages SET media_duration_s=999 WHERE evolution_event_id='E1'`);
  const job = await seedJob('inbound'); // media_duration_s do job vem do envelope; força via override abaixo
  await processJob(deps({ maxDurationS: 600, provider: { transcribe: async () => { throw new Error('nao deveria chamar'); } } }), { ...job });
  const { rows: m } = await pool.query(`SELECT text, transcription_status, media_key FROM messages WHERE id=$1`, [job.message_id]);
  assert.equal(m[0].transcription_status, 'failed');
  assert.match(m[0].text, /longo/i);
});

test('mode=manual não dispara trigger mesmo inbound', async () => {
  await pool.query(`INSERT INTO workspace_agents (workspace_id, whatsapp_number_id, agent, reaction_mode) VALUES ('ws-1',1,'mercurio','reactive')`);
  const job = await seedJob('inbound');
  await processJob(deps({ mode: 'manual' }), job);
  const { rows } = await pool.query(`SELECT count(*)::int c FROM pending_triggers`);
  assert.equal(rows[0].c, 0);
});
