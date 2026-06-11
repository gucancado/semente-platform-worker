import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import {
  insertEventTx, expandPendingEvents, claimDueDeliveries,
  markDeliveryDelivered, markDeliveryRetryOrDead, requeueDelivery,
} from '../../src/events/outbox.js';

const SUBS = { episodio_pronto_v1: { lua: { url: 'http://localhost:1/x', secrets: ['secret-1'] } } };

beforeEach(async () => {
  await pool.query('TRUNCATE event_outbox_deliveries, event_outbox RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('expansão atômica: evento vira 1 delivery por assinante e dispatched_at é setado', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertEventTx(client, { event_type: 'episodio_pronto_v1', aggregate_type: 'episode', aggregate_id: '1', payload: { x: 1 } });
    await client.query('COMMIT');
  } finally { client.release(); }
  const n = await expandPendingEvents(SUBS, 10);
  assert.equal(n, 1);
  const { rows: d } = await pool.query('SELECT * FROM event_outbox_deliveries');
  assert.equal(d.length, 1);
  assert.equal(d[0].subscriber_key, 'lua');
  const { rows: e } = await pool.query('SELECT dispatched_at FROM event_outbox');
  assert.ok(e[0].dispatched_at);
});

test('zero assinantes pro event_type: marca dispatched sem deliveries (não entope a fila)', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertEventTx(client, { event_type: 'tipo_sem_assinante_v1', aggregate_type: 'x', aggregate_id: '1', payload: {} });
    await client.query('COMMIT');
  } finally { client.release(); }
  await expandPendingEvents(SUBS, 10);
  const { rows: e } = await pool.query('SELECT dispatched_at FROM event_outbox');
  assert.ok(e[0].dispatched_at);
  const { rows: d } = await pool.query('SELECT count(*)::int AS n FROM event_outbox_deliveries');
  assert.equal(d[0].n, 0);
});

test('claim + retry com backoff + dead após max + requeue', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertEventTx(client, { event_type: 'episodio_pronto_v1', aggregate_type: 'episode', aggregate_id: '2', payload: {} });
    await client.query('COMMIT');
  } finally { client.release(); }
  await expandPendingEvents(SUBS, 10);
  const claimed = await claimDueDeliveries(10);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].attempt_count, 1);
  let r = await markDeliveryRetryOrDead(claimed[0].id, 1, 2, 'boom');
  assert.equal(r.dead, false);
  r = await markDeliveryRetryOrDead(claimed[0].id, 2, 2, 'boom2');
  assert.equal(r.dead, true);
  await requeueDelivery(claimed[0].id);
  const { rows } = await pool.query('SELECT status, attempt_count, last_error FROM event_outbox_deliveries WHERE id=$1', [claimed[0].id]);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].attempt_count, 0);
  assert.equal(rows[0].last_error, 'boom2');
});
