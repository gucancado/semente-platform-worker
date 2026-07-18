// tests/whatsapp/set-lead-derive.db.test.ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerWriteRoutes } from '../../src/whatsapp/write-routes.js';

const TOKEN = 'tkn';
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };
function buildApp() { const app = Fastify(); registerWriteRoutes(app, { pool, panelToken: TOKEN, authz: passAuthz }); return app; }

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, whatsapp_thread_meta RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
});
after(() => pool.end());

test('single: stage=desqualificado SEM status → is_lead=false (derivado)', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: '/whatsapp/threads/c1/lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'u1' },
    payload: { number_id: 1, stage: 'desqualificado' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().leadStatus, 'not_lead');
  const r = await pool.query(`SELECT is_lead, lead_stage FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier='c1'`);
  assert.equal(r.rows[0].is_lead, false);
  assert.equal(r.rows[0].lead_stage, 'desqualificado');
  await app.close();
});

test('single: stage=qualificado SEM status → is_lead=true (derivado)', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: '/whatsapp/threads/c2/lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'u1' },
    payload: { number_id: 1, stage: 'qualificado' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().leadStatus, 'lead');
  await app.close();
});

test('single: sem status e sem stage → 400', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: '/whatsapp/threads/c3/lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'u1' },
    payload: { number_id: 1, temperature: 'quente' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('single: status explícito continua valendo (compat)', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: '/whatsapp/threads/c4/lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'u1' },
    payload: { number_id: 1, status: 'not_lead' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().leadStatus, 'not_lead');
  await app.close();
});

test('bulk: item com stage=desqualificado sem status → not_lead', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: '/whatsapp/threads/bulk-lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'u1' },
    payload: { number_id: 1, updates: [{ identifier: 'c5', stage: 'desqualificado' }] } });
  assert.equal(res.statusCode, 400, 'c5 não existe em messages/meta → identifiers not found (esperado)');
  // cria o thread e repete
  await pool.query(`INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead) VALUES (1,'c5',TRUE)`);
  const res2 = await app.inject({ method: 'POST', url: '/whatsapp/threads/bulk-lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'u1' },
    payload: { number_id: 1, updates: [{ identifier: 'c5', stage: 'desqualificado' }] } });
  assert.equal(res2.statusCode, 200);
  const r = await pool.query(`SELECT is_lead FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier='c5'`);
  assert.equal(r.rows[0].is_lead, false);
  await app.close();
});
