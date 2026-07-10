import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { handleConnectionEvent } from '../../src/whatsapp/connection-events.js';
import { upsertConnectedNumber } from '../../src/whatsapp/numbers.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE event_outbox RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('reconexão após alerta disparado enfileira evento resolved no outbox', async () => {
  await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'i-1', phone: '+5531999', createdBy: null });
  // simula queda + alerta já disparado
  await pool.query(`UPDATE whatsapp_numbers SET status='disconnected', disconnected_since=NOW(), alerted_at=NOW() WHERE evolution_instance='i-1'`);
  // reconecta
  await handleConnectionEvent(pool, { event: 'connection.update', instance: 'i-1', data: { state: 'open', wuid: '5531999@s.whatsapp.net' } });
  const { rows } = await pool.query(`SELECT event_type, payload FROM event_outbox WHERE event_type='whatsapp_conexao_v1'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.status, 'resolved');
  assert.equal(rows[0].payload.workspaceId, 'ws-1');
});

test('reconexão SEM alerta anterior não enfileira nada (evitar ruído de flapping)', async () => {
  await upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'i-1', phone: '+5531999', createdBy: null });
  await pool.query(`UPDATE whatsapp_numbers SET status='disconnected', disconnected_since=NOW() WHERE evolution_instance='i-1'`); // alerted_at NULL
  await handleConnectionEvent(pool, { event: 'connection.update', instance: 'i-1', data: { state: 'open', wuid: '5531999@s.whatsapp.net' } });
  const { rows } = await pool.query(`SELECT count(*)::int n FROM event_outbox`);
  assert.equal(rows[0].n, 0);
});
