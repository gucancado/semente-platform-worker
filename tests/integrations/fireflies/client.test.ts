import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FirefliesClient } from '../../../src/integrations/fireflies/client.js';

const noopSleep = async (_ms: number) => {};

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    json: async () => payload,
  } as unknown as Response;
}

function timeoutError(): Error {
  const e = new Error('The operation timed out');
  e.name = 'AbortError';
  return e;
}

test('construtor com chave vazia → throw', () => {
  assert.throws(() => new FirefliesClient(''), /ausente ou vazia/);
  assert.throws(() => new FirefliesClient('   '), /ausente ou vazia/);
});

test('page(): timeout na 1ª, sucesso na 2ª → retorna dados, 2 chamadas', async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls === 1) throw timeoutError();
    return jsonResponse(200, { data: { transcripts: [{ id: 'ff-1' }] } });
  }) as unknown as typeof fetch;
  const client = new FirefliesClient('key', fetchFn, 'https://x', 3, noopSleep);
  const out = await client.page({});
  assert.equal(calls, 2);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, 'ff-1');
});

test('page(): 3 timeouts → throw "após N tentativas"', async () => {
  let calls = 0;
  const fetchFn = (async () => { calls++; throw timeoutError(); }) as unknown as typeof fetch;
  const client = new FirefliesClient('key', fetchFn, 'https://x', 3, noopSleep);
  await assert.rejects(() => client.page({}), /após 3 tentativas/);
  assert.equal(calls, 3);
});

test('page(): HTTP 401 → throw imediato, sem retry, com status e corpo', async () => {
  let calls = 0;
  const fetchFn = (async () => { calls++; return jsonResponse(401, 'Unauthorized'); }) as unknown as typeof fetch;
  const client = new FirefliesClient('key', fetchFn, 'https://x', 3, noopSleep);
  await assert.rejects(() => client.page({}), /HTTP 401.*Unauthorized/s);
  assert.equal(calls, 1);
});

test('page(): HTTP 500 três vezes → re-tenta e depois throw', async () => {
  let calls = 0;
  const fetchFn = (async () => { calls++; return jsonResponse(500, 'boom'); }) as unknown as typeof fetch;
  const client = new FirefliesClient('key', fetchFn, 'https://x', 3, noopSleep);
  await assert.rejects(() => client.page({}), /após 3 tentativas.*HTTP 500/s);
  assert.equal(calls, 3);
});

test('page(): json.errors presente (HTTP 200) → throw surfaceando mensagem', async () => {
  const fetchFn = (async () => jsonResponse(200, { errors: [{ message: 'query inválida' }] })) as unknown as typeof fetch;
  const client = new FirefliesClient('key', fetchFn, 'https://x', 3, noopSleep);
  await assert.rejects(() => client.page({}), /query inválida/);
});

test('ping(): retorna {status, body} sem throw', async () => {
  const fetchFn = (async () => jsonResponse(200, { data: { user: { name: 'G' } } })) as unknown as typeof fetch;
  const client = new FirefliesClient('key', fetchFn, 'https://x', 3, noopSleep);
  const res = await client.ping();
  assert.equal(res.status, 200);
  assert.match(res.body, /user/);
});
