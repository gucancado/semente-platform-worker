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

/** Dois ticks consecutivos fora — o primeiro é suspeita, o segundo abre o episódio. */
async function twoDownTicks(observed: Date | null = null) {
  await recordSystemHealth(pool, T, DOWN as any, observed);
  return recordSystemHealth(pool, T, DOWN as any, observed);
}

test('PRIMEIRO tick de instância nova, já fora: grava saúde como SUSPEITA e NÃO abre episódio', async () => {
  const r = await recordSystemHealth(pool, T, DOWN as any);
  assert.equal(r.downSince, null);
  assert.equal((await outages()).length, 0);
  // A suspeita fica gravada: é ela que o tick seguinte lê para confirmar.
  const { rows } = await pool.query(`SELECT last_reason FROM system_instance_health`);
  assert.equal(rows[0].last_reason, 'state');
});

test('SEGUNDO tick consecutivo fora ABRE o episódio', async () => {
  const r = await twoDownTicks();
  assert.notEqual(r.downSince, null);
  const rows = await outages();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'system');
  assert.equal(rows[0].number_id, null);
  assert.equal(rows[0].started_at_source, 'detected_now');
  assert.equal(rows[0].reason, 'state');
  // saúde e episódio nascem com o MESMO início — comparado NO BANCO, em microssegundo:
  // o Date do JS só tem milissegundo e esconderia um NOW() truncado no caminho.
  assert.equal((rows[0].started_at as Date).getTime(), r.downSince!.getTime());
  const same = await pool.query(
    `SELECT o.started_at = h.down_since AS same
       FROM instance_outages o JOIN system_instance_health h ON h.instance = o.instance`,
  );
  assert.equal(same.rows[0].same, true);
});

test('flap de um tick (fora → saudável) não deixa rastro em instance_outages', async () => {
  await recordSystemHealth(pool, T, DOWN as any);
  await recordSystemHealth(pool, T, UP as any);
  await recordSystemHealth(pool, T, DOWN as any);
  await recordSystemHealth(pool, T, UP as any);
  assert.equal((await outages()).length, 0);
});

test('início ESTIMADO vira observed_store', async () => {
  const observed = new Date('2026-09-09T18:10:00Z');
  await twoDownTicks(observed);
  const rows = await outages();
  assert.equal(rows[0].started_at_source, 'observed_store');
  assert.equal(rows[0].started_at.toISOString(), '2026-09-09T18:10:00.000Z');
});

test('ticks seguidos em queda NÃO abrem episódio novo', async () => {
  await recordSystemHealth(pool, T, DOWN as any);
  await recordSystemHealth(pool, T, DOWN as any);
  await recordSystemHealth(pool, T, DOWN as any);
  await recordSystemHealth(pool, T, DOWN as any);
  assert.equal((await outages()).length, 1);
});

test('volta a saudável FECHA o episódio; queda seguinte abre outro', async () => {
  await twoDownTicks();
  await recordSystemHealth(pool, T, UP as any);
  let rows = await outages();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].ended_at, null);
  await twoDownTicks();
  rows = await outages();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].ended_at, null);
});

test('observações CONCORRENTES fora nunca produzem mais de um episódio aberto', async () => {
  await Promise.all([
    recordSystemHealth(pool, T, DOWN as any),
    recordSystemHealth(pool, T, DOWN as any),
    recordSystemHealth(pool, T, DOWN as any),
  ]);
  const rows = await outages();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ended_at, null);
});

test('episódio ÓRFÃO já aberto é mantido: abrir de novo não duplica nem quebra o índice único', async () => {
  await pool.query(
    `INSERT INTO instance_outages (instance, kind, number_id, started_at, started_at_source, reason, detected_by)
     VALUES ('saturno', 'system', NULL, NOW() - INTERVAL '2 days', 'detected_now', 'state', 'watch')`,
  );
  const r = await twoDownTicks();
  assert.notEqual(r.downSince, null);
  const rows = await outages();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ended_at, null);
});
