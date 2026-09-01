import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, insertMessage, insertTranscriptionJob, claimDueTranscriptionJobs,
  markTranscriptionDone, markTranscriptionRetryOrFail, getTranscriptionJobByMessageId } from '../../src/db.js';

beforeEach(async () => {
  await pool.query('TRUNCATE transcription_jobs, messages, whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws-1','inst-1')`);
});
after(() => pool.end());

async function seedAudioMsg(eventId: string) {
  const m = await insertMessage({ agent: null, channel: 'whatsapp', identifier: '+55a', direction: 'inbound',
    text: '[áudio]', evolution_event_id: eventId, whatsapp_number_id: 1, workspace_id: 'ws-1',
    kind: 'audio', media_mime: 'audio/ogg', media_duration_s: 5, transcription_status: 'pending' });
  return m.id;
}

test('insertMessage grava kind=audio no branch number-path', async () => {
  const id = await seedAudioMsg('E1');
  const { rows } = await pool.query(`SELECT kind, transcription_status, media_duration_s FROM messages WHERE id=$1`, [id]);
  assert.equal(rows[0].kind, 'audio');
  assert.equal(rows[0].transcription_status, 'pending');
  assert.equal(rows[0].media_duration_s, 5);
});

test('insertTranscriptionJob é idempotente por (number, evento)', async () => {
  const mid = await seedAudioMsg('E1');
  const a = await insertTranscriptionJob({ message_id: mid, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: 'inbound', is_group: false, identifier: '+55a', inbox_id: 10, raw_envelope: { k: 1 } });
  const b = await insertTranscriptionJob({ message_id: mid, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: 'inbound', is_group: false, identifier: '+55a', inbox_id: 10, raw_envelope: { k: 1 } });
  assert.ok(a.id);
  assert.equal(b.id, null);
  const { rows } = await pool.query(`SELECT count(*)::int c FROM transcription_jobs`);
  assert.equal(rows[0].c, 1);
});

test('claim bumpa attempts e empurra scheduled_at (auto-cura de crash)', async () => {
  const mid = await seedAudioMsg('E1');
  await insertTranscriptionJob({ message_id: mid, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: 'inbound', is_group: false, identifier: '+55a', inbox_id: 10, raw_envelope: {} });
  const first = await claimDueTranscriptionJobs(10);
  assert.equal(first.length, 1);
  assert.equal(first[0].attempts, 1);
  const second = await claimDueTranscriptionJobs(10);
  assert.equal(second.length, 0, 'já claimado → scheduled_at futuro → não reaparece já');
});

test('markTranscriptionDone zera raw_envelope', async () => {
  const mid = await seedAudioMsg('E1');
  const j = await insertTranscriptionJob({ message_id: mid, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: 'inbound', is_group: false, identifier: '+55a', inbox_id: 10, raw_envelope: { pii: 'x' } });
  await markTranscriptionDone(j.id!);
  const { rows } = await pool.query(`SELECT status, raw_envelope FROM transcription_jobs WHERE id=$1`, [j.id]);
  assert.equal(rows[0].status, 'done');
  assert.deepEqual(rows[0].raw_envelope, {});
});

test('markTranscriptionRetryOrFail: retry até max, depois failed', async () => {
  const mid = await seedAudioMsg('E1');
  const j = await insertTranscriptionJob({ message_id: mid, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: 'inbound', is_group: false, identifier: '+55a', inbox_id: 10, raw_envelope: {} });
  const r1 = await markTranscriptionRetryOrFail(j.id!, 1, 4, 'boom');
  assert.equal(r1.retried, true);
  const r2 = await markTranscriptionRetryOrFail(j.id!, 4, 4, 'boom');
  assert.equal(r2.retried, false);
  const { rows } = await pool.query(`SELECT status, last_error FROM transcription_jobs WHERE id=$1`, [j.id]);
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].last_error, 'boom');
});

test('markTranscriptionRetryOrFail: falha SISTÊMICA não consome tentativa e mantém o job vivo', async () => {
  // Regressão do apagão de 2026-08-24/31: 1.002 jobs viraram `failed` permanente
  // porque o 429 "no credits" gastou as 4 tentativas de cada um em minutos.
  const mid = await seedAudioMsg('E1');
  const j = await insertTranscriptionJob({ message_id: mid, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: 'inbound', is_group: false, identifier: '+55a', inbox_id: 10, raw_envelope: {} });
  await pool.query(`UPDATE transcription_jobs SET attempts=4 WHERE id=$1`, [j.id]);

  const r = await markTranscriptionRetryOrFail(j.id!, 4, 4, '429 You have no credits remaining.', {
    createdAt: new Date(),
  });
  assert.equal(r.retried, true, 'attempts no limite não pode falhar quando a culpa é do ambiente');
  assert.equal(r.systemic, true);

  const { rows } = await pool.query(`SELECT status, attempts FROM transcription_jobs WHERE id=$1`, [j.id]);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].attempts, 3, 'a tentativa consumida pelo claim é devolvida');
});

test('markTranscriptionRetryOrFail: sistêmico velho demais vira failed — a fila não é infinita', async () => {
  const mid = await seedAudioMsg('E1');
  const j = await insertTranscriptionJob({ message_id: mid, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: 'inbound', is_group: false, identifier: '+55a', inbox_id: 10, raw_envelope: {} });
  const velho = new Date(Date.now() - 100 * 3_600_000); // 100h
  const r = await markTranscriptionRetryOrFail(j.id!, 1, 4, '429 You have no credits remaining.', {
    createdAt: velho,
    systemicMaxAgeH: 72,
  });
  assert.equal(r.retried, false);
  const { rows } = await pool.query(`SELECT status FROM transcription_jobs WHERE id=$1`, [j.id]);
  assert.equal(rows[0].status, 'failed');
});
