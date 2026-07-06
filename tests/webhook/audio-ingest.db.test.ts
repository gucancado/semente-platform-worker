/**
 * tests/webhook/audio-ingest.db.test.ts
 *
 * SERVER-GATED (Postgres efêmero) — exercita POST /webhook end-to-end (number-path)
 * pro caminho de áudio em modo `manual` (fixado via .env.test, já que `config` é lido
 * uma vez no import do módulo — auto/off ficam cobertos pelo teste unitário de
 * `audioIngestPlan` em tests/webhook/audio-plan.test.ts).
 *
 * Cobre:
 *  - áudio DM novo → 1 row messages(kind='audio', transcription_status='pending'),
 *    1 row transcription_jobs, 1 pending_trigger (manual não suprime o trigger).
 *  - reentrega do MESMO evolution_event_id → idempotente (sem duplicar message/job/trigger).
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerWebhookRoutes } from '../../src/webhook/routes.js';

const SECRET = process.env.EVOLUTION_WEBHOOK_SECRET!;

function audioEvent(eventId: string, fromMe = false, group = false) {
  return {
    event: 'messages.upsert',
    instance: 'inst-1',
    data: {
      key: { remoteJid: group ? '123@g.us' : '5531999998888@s.whatsapp.net', fromMe, id: eventId },
      message: { audioMessage: { mimetype: 'audio/ogg', seconds: 4 } },
    },
  };
}

function buildApp() {
  const app = Fastify({ logger: false });
  registerWebhookRoutes(app);
  return app;
}

beforeEach(async () => {
  await pool.query(
    'TRUNCATE transcription_jobs, messages, webhook_logs, pending_triggers, whatsapp_numbers, workspace_agents RESTART IDENTITY CASCADE'
  );
  await pool.query(
    `INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance, mode, status) VALUES (1,'ws-1','inst-1','agent_operated','connected')`
  );
  // agente reactive operando o número 1 — necessário pro trigger disparar.
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent, enabled, config)
     VALUES ('ws-1','mercurio', TRUE, '{"operates_numbers":[1],"reaction_mode":"reactive"}'::jsonb)`
  );
});

after(() => pool.end());

test('manual: áudio DM → messages kind=audio pending + job + trigger dispara', async () => {
  const app = buildApp();

  const res = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'x-evolution-secret': SECRET },
    payload: audioEvent('E1'),
  });

  assert.equal(res.statusCode, 200, `esperado 200, got ${res.statusCode}: ${res.body}`);

  const { rows: msgs } = await pool.query(
    `SELECT kind, text, transcription_status, media_mime, media_duration_s, whatsapp_number_id FROM messages`
  );
  assert.equal(msgs.length, 1, 'esperada 1 row em messages');
  assert.equal(msgs[0].kind, 'audio');
  assert.equal(msgs[0].text, '[áudio]');
  assert.equal(msgs[0].transcription_status, 'pending');
  assert.equal(msgs[0].media_mime, 'audio/ogg');
  assert.equal(msgs[0].media_duration_s, 4);
  assert.equal(msgs[0].whatsapp_number_id, 1);

  const { rows: jobs } = await pool.query(
    `SELECT evolution_event_id, whatsapp_number_id, direction, is_group, status FROM transcription_jobs`
  );
  assert.equal(jobs.length, 1, 'esperado 1 job de transcrição');
  assert.equal(jobs[0].evolution_event_id, 'E1');
  assert.equal(jobs[0].whatsapp_number_id, 1);
  assert.equal(jobs[0].direction, 'inbound');
  assert.equal(jobs[0].is_group, false);
  assert.equal(jobs[0].status, 'pending');

  const { rows: trig } = await pool.query(`SELECT count(*)::int c FROM pending_triggers WHERE status='pending'`);
  assert.equal(trig[0].c, 1, 'manual não suprime o trigger — deve enfileirar 1 pending_trigger');

  await app.close();
});

test('reentrega do mesmo evento não duplica message nem job', async () => {
  const app = buildApp();

  const first = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'x-evolution-secret': SECRET },
    payload: audioEvent('E1'),
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'x-evolution-secret': SECRET },
    payload: audioEvent('E1'),
  });
  assert.equal(second.statusCode, 200);

  const { rows: msgCount } = await pool.query(`SELECT count(*)::int c FROM messages WHERE kind='audio'`);
  assert.equal(msgCount[0].c, 1, 'reentrega não deve duplicar a message de áudio');

  const { rows: jobCount } = await pool.query(`SELECT count(*)::int c FROM transcription_jobs`);
  assert.equal(jobCount[0].c, 1, 'reentrega não deve duplicar o transcription_job');

  const { rows: trig } = await pool.query(`SELECT count(*)::int c FROM pending_triggers`);
  assert.equal(trig[0].c, 1, 'reentrega não deve enfileirar um 2º pending_trigger');

  await app.close();
});
