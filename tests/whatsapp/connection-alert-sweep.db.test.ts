import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { upsertConnectedNumber } from '../../src/whatsapp/numbers.js';
import { sweepDisconnectionAlerts } from '../../src/whatsapp/connection-alerts.js';

const evo = { baseUrl: 'http://evo.test', apiKey: 'k' };

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE event_outbox RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('número fora do ar além do debounce dispara alerta e carimba alerted_at (idempotente)', async () => {
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'i-1', phone: '+5531999', createdBy: null });
  await pool.query(`UPDATE whatsapp_numbers SET status='disconnected', disconnected_since=NOW() - INTERVAL '10 minutes' WHERE id=$1`, [n.id]);
  // sem sender/target → só outbox (sem push, sem depender de rede)
  const fired = await sweepDisconnectionAlerts(pool, { debounceMs: 300_000, evolution: evo });
  assert.equal(fired, 1);
  const ev = await pool.query(`SELECT payload FROM event_outbox WHERE event_type='whatsapp_conexao_v1'`);
  assert.equal(ev.rows.length, 1);
  assert.equal(ev.rows[0].payload.status, 'down');
  assert.equal(ev.rows[0].payload.workspaceId, 'ws-1');
  const row = await pool.query(`SELECT alerted_at FROM whatsapp_numbers WHERE id=$1`, [n.id]);
  assert.notEqual(row.rows[0].alerted_at, null);
  // 2ª passada não redispara (idempotência por alerted_at)
  assert.equal(await sweepDisconnectionAlerts(pool, { debounceMs: 300_000, evolution: evo }), 0);
});

test('fora do ar DENTRO do debounce não dispara', async () => {
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'i-1', phone: '+5531999', createdBy: null });
  await pool.query(`UPDATE whatsapp_numbers SET status='disconnected', disconnected_since=NOW() - INTERVAL '2 minutes' WHERE id=$1`, [n.id]);
  assert.equal(await sweepDisconnectionAlerts(pool, { debounceMs: 300_000, evolution: evo }), 0);
});

test('número removido (removed_at) não dispara', async () => {
  const n = await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'i-1', phone: '+5531999', createdBy: null });
  await pool.query(`UPDATE whatsapp_numbers SET status='disconnected', disconnected_since=NOW() - INTERVAL '10 minutes', removed_at=NOW() WHERE id=$1`, [n.id]);
  assert.equal(await sweepDisconnectionAlerts(pool, { debounceMs: 300_000, evolution: evo }), 0);
});
