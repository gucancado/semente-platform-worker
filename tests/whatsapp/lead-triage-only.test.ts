import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerWriteRoutes } from '../../src/whatsapp/write-routes.js';
import { applyLeadUpdate } from '../../src/whatsapp/thread-meta.js';

const TOKEN = 'test-panel';
const HEADERS = { 'x-panel-token': TOKEN, 'x-acting-user': 'user-1' };
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };

const PANIC_POOL = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'query' || prop === 'connect') {
      return () => Promise.reject(new Error('DB should not be reached'));
    }
    return undefined;
  },
}) as any;

async function postSingle(payload: Record<string, unknown>) {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: TOKEN, authz: passAuthz });
  const response = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/thread-1/lead',
    headers: HEADERS,
    payload: { number_id: 1, status: 'lead', ...payload },
  });
  await app.close();
  return response;
}

for (const field of ['stage', 'temperature', 'tags'] as const) {
  test(`single: payload com ${field} retorna 400 de campo descontinuado`, async () => {
    const value = field === 'tags' ? ['vip'] : 'qualificado';
    const response = await postSingle({ [field]: value });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), {
      error: 'campo descontinuado: use as rotas/tools de oportunidades',
    });
  });
}

function makeClient() {
  const calls: { sql: string; params: unknown[] | undefined }[] = [];
  return {
    calls,
    client: {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        if (sql.includes('SELECT is_lead')) return { rows: [{ is_lead: true }] };
        return { rows: [] };
      },
    } as any,
  };
}

test('notes:null limpa com CASE e flag de presença true', async () => {
  const { client, calls } = makeClient();
  await applyLeadUpdate(client, {
    numberId: 1, identifier: 'thread-1', isLead: true, updatedBy: 'user-1',
    notesPresent: true, notes: null,
  });
  const upsert = calls.find((call) => call.sql.includes('INSERT INTO whatsapp_thread_meta'))!;
  assert.match(upsert.sql, /notes\s*=\s*CASE WHEN/);
  assert.equal(upsert.params?.[7], true);
  assert.equal(upsert.params?.[8], null);
});

test('notes omitido preserva com flag de presença false', async () => {
  const { client, calls } = makeClient();
  await applyLeadUpdate(client, {
    numberId: 1, identifier: 'thread-1', isLead: true, updatedBy: 'user-1',
  });
  const upsert = calls.find((call) => call.sql.includes('INSERT INTO whatsapp_thread_meta'))!;
  assert.equal(upsert.params?.[7], false);
});

test('source:null limpa com CASE e flag de presença true', async () => {
  const { client, calls } = makeClient();
  await applyLeadUpdate(client, {
    numberId: 1, identifier: 'thread-1', isLead: true, updatedBy: 'user-1',
    sourcePresent: true, source: null,
  });
  const upsert = calls.find((call) => call.sql.includes('INSERT INTO whatsapp_thread_meta'))!;
  assert.match(upsert.sql, /lead_source\s*=\s*CASE WHEN/);
  assert.equal(upsert.params?.[3], true);
  assert.equal(upsert.params?.[4], null);
});

test('disqualifyReason exige status not_lead', async () => {
  const response = await postSingle({ disqualifyReason: 'sem_fit' });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /disqualifyReason.*not_lead/);
});

test('bulk: item com stage retorna erro citando o campo', async () => {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool: PANIC_POOL, panelToken: TOKEN, authz: passAuthz });
  const response = await app.inject({
    method: 'POST',
    url: '/whatsapp/threads/bulk-lead',
    headers: HEADERS,
    payload: { number_id: 1, updates: [{ identifier: 'thread-1', status: 'lead', stage: 'qualificado' }] },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /stage/);
  assert.match(response.json().error, /campo descontinuado/);
  await app.close();
});
