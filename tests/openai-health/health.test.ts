import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProbe, transitionOf, sttAffectedSince, silentWav } from '../../src/openai-health/core.js';
import { runHealthTick } from '../../src/openai-health/service.js';

test('classifyProbe: só 2xx é ok; 401/403 e 429 de crédito são down', () => {
  assert.equal(classifyProbe(200, '{"text":""}'), 'ok');
  assert.equal(classifyProbe(401, 'invalid key'), 'down');
  assert.equal(classifyProbe(429, '{"error":{"code":"insufficient_quota"}}'), 'down');
  assert.equal(classifyProbe(429, 'You have no credits remaining'), 'down');
});

test('classifyProbe: rate limit comum, 5xx e rede não dizem nada da conta', () => {
  assert.equal(classifyProbe(429, 'Rate limit reached for requests'), 'unknown');
  assert.equal(classifyProbe(500, 'oops'), 'unknown');
  assert.equal(classifyProbe(null, 'ECONNRESET'), 'unknown');
});

test('transitionOf: aviso só na mudança', () => {
  assert.equal(transitionOf('ok', 'down'), 'went_down');
  assert.equal(transitionOf('unknown', 'down'), 'went_down');
  assert.equal(transitionOf('down', 'ok'), 'came_back');
  assert.equal(transitionOf('unknown', 'ok'), null);
  assert.equal(transitionOf('down', 'down'), null);
  assert.equal(transitionOf('down', 'unknown'), null);
});

test('sttAffectedSince: fora agora, ou caiu depois do início', () => {
  const start = new Date('2026-10-02T12:47:00Z');
  assert.equal(sttAffectedSince({ state: 'down', lastDownAt: null }, start), true);
  assert.equal(sttAffectedSince({ state: 'ok', lastDownAt: new Date('2026-10-02T13:00:00Z') }, start), true);
  assert.equal(sttAffectedSince({ state: 'ok', lastDownAt: new Date('2026-10-02T12:00:00Z') }, start), false);
  assert.equal(sttAffectedSince({ state: 'unknown', lastDownAt: null }, start), false);
});

test('silentWav: cabeçalho RIFF/WAVE de 1 s a 16 kHz', () => {
  const w = silentWav();
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.toString('ascii', 8, 12), 'WAVE');
  assert.equal(w.length, 44 + 32000);
});

function healthPool(state: string, updateRows = 1) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    pool: {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (/^SELECT state/.test(sql.trim())) return { rows: [{ state, since: new Date(0), last_down_at: null, checked_at: null }] };
        return { rows: [], rowCount: /UPDATE openai_health\s+SET state/.test(sql) ? updateRows : 1 };
      },
    } as any,
  };
}

test('runHealthTick: queda avisa uma vez', async () => {
  const { pool } = healthPool('ok');
  const sent: string[] = [];
  const s = await runHealthTick({ pool, probe: async () => ({ status: 429, body: 'insufficient_quota' }), notify: async (n) => { sent.push(n.titulo); } });
  assert.equal(s, 'down');
  assert.deepEqual(sent, ['OpenAI sem crédito']);
});

test('runHealthTick: outro container já trocou o estado → não reavisa', async () => {
  const { pool } = healthPool('ok', 0);
  const sent: string[] = [];
  await runHealthTick({ pool, probe: async () => ({ status: 429, body: 'insufficient_quota' }), notify: async (n) => { sent.push(n.titulo); } });
  assert.deepEqual(sent, []);
});

test('runHealthTick: sonda inconclusiva não muda estado nem avisa', async () => {
  const { pool, calls } = healthPool('down');
  const sent: string[] = [];
  const s = await runHealthTick({ pool, probe: async () => ({ status: null, body: 'timeout' }), notify: async (n) => { sent.push(n.titulo); } });
  assert.equal(s, 'down');
  assert.deepEqual(sent, []);
  assert.equal(calls.some((c) => /SET state/.test(c.sql)), false);
});

test('runHealthTick: volta avisa', async () => {
  const { pool } = healthPool('down');
  const sent: string[] = [];
  await runHealthTick({ pool, probe: async () => ({ status: 200, body: '{}' }), notify: async (n) => { sent.push(n.titulo); } });
  assert.deepEqual(sent, ['OpenAI voltou']);
});
