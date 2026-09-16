// tests/whatsapp/instance-outages-system.db.test.ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { recordSystemHealth } from '../../src/whatsapp/down-notify-store.js';

beforeEach(async () => {
  await pool.query('TRUNCATE system_instance_health, instance_outages RESTART IDENTITY');
});
after(() => pool.end());

const T = { instance: 'saturno', expectedPhone: '+553195950748', label: 'Monitor de grupos' };
const DOWN = { state: 'close', reason: 'state' as const, down: true, ownStoreTs: null, peerStoreTs: null };
const UP = { state: 'open', reason: null, down: false, ownStoreTs: null, peerStoreTs: null };
const outages = async () => (await pool.query(`SELECT * FROM instance_outages ORDER BY id`)).rows;

test('PRIMEIRO tick de instância nova, saudável: grava saúde e NENHUM episódio', async () => {
  const r = await recordSystemHealth(pool, T, UP as any);
  assert.equal(r.downSince, null);
  assert.equal((await outages()).length, 0);
  // A linha de saúde TEM que existir — é o caso que um `INSERT ... SELECT FROM prev`
  // faria sumir (prev vazia ⇒ zero linhas inseridas).
  const { rows } = await pool.query(`SELECT count(*)::int c FROM system_instance_health`);
  assert.equal(rows[0].c, 1);
});

test('PRIMEIRO tick de instância nova, já fora: grava saúde e ABRE episódio', async () => {
  const r = await recordSystemHealth(pool, T, DOWN as any);
  assert.notEqual(r.downSince, null);
  const rows = await outages();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'system');
  assert.equal(rows[0].number_id, null);
  assert.equal(rows[0].started_at_source, 'detected_now');
  assert.equal(rows[0].reason, 'state');
});

test('início ESTIMADO vira observed_store', async () => {
  const observed = new Date('2026-09-09T18:10:00Z');
  await recordSystemHealth(pool, T, DOWN as any, observed);
  const rows = await outages();
  assert.equal(rows[0].started_at_source, 'observed_store');
  assert.equal(rows[0].started_at.toISOString(), '2026-09-09T18:10:00.000Z');
});

test('ticks seguidos em queda NÃO abrem episódio novo', async () => {
  await recordSystemHealth(pool, T, DOWN as any);
  await recordSystemHealth(pool, T, DOWN as any);
  await recordSystemHealth(pool, T, DOWN as any);
  assert.equal((await outages()).length, 1);
});

test('volta a saudável FECHA o episódio; queda seguinte abre outro', async () => {
  await recordSystemHealth(pool, T, DOWN as any);
  await recordSystemHealth(pool, T, UP as any);
  let rows = await outages();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].ended_at, null);
  await recordSystemHealth(pool, T, DOWN as any);
  rows = await outages();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].ended_at, null);
});

test('duas primeiras observações CONCORRENTES produzem um episódio só', async () => {
  await Promise.all([
    recordSystemHealth(pool, T, DOWN as any),
    recordSystemHealth(pool, T, DOWN as any),
  ]);
  assert.equal((await outages()).length, 1);
});
