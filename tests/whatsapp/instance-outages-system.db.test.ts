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

/**
 * Faz o tempo passar para a suspeita: recua o `checked_at`, que é o relógio dela.
 * A segunda observação só confirma com a suspeita entre ~meio e ~3 intervalos de idade.
 */
const age = (interval: string) =>
  pool.query(`UPDATE system_instance_health SET checked_at = NOW() - $1::interval`, [interval]);
const checkedAt = async () =>
  (await pool.query(`SELECT checked_at::text AS t FROM system_instance_health`)).rows[0].t as string;

/** Duas observações fora separadas por um intervalo do vigia: a 1ª é suspeita, a 2ª abre o episódio. */
async function twoDownTicks(observed: Date | null = null) {
  await recordSystemHealth(pool, T, DOWN as any, observed);
  await age('5 minutes');
  return recordSystemHealth(pool, T, DOWN as any, observed);
}

test('PRIMEIRO tick de instância nova, saudável: grava saúde e NENHUM episódio', async () => {
  const r = await recordSystemHealth(pool, T, UP as any);
  assert.equal(r.downSince, null);
  assert.equal((await outages()).length, 0);
  // A linha de saúde TEM que existir — é o caso que um `INSERT ... SELECT FROM prev`
  // faria sumir (prev vazia ⇒ zero linhas inseridas).
  const { rows } = await pool.query(`SELECT count(*)::int c FROM system_instance_health`);
  assert.equal(rows[0].c, 1);
});

test('PRIMEIRO tick de instância nova, já fora: grava saúde como SUSPEITA e NÃO abre episódio', async () => {
  const r = await recordSystemHealth(pool, T, DOWN as any);
  assert.equal(r.downSince, null);
  assert.equal((await outages()).length, 0);
  // A suspeita fica gravada: é ela que a observação seguinte lê para confirmar.
  const { rows } = await pool.query(`SELECT last_reason FROM system_instance_health`);
  assert.equal(rows[0].last_reason, 'state');
});

test('segunda observação NO PRAZO (um intervalo depois) ABRE o episódio', async () => {
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

test('sem estimativa pelo store, o episódio começa na PRIMEIRA observação fora — não um intervalo depois', async () => {
  await recordSystemHealth(pool, T, DOWN as any);
  await age('5 minutes');
  const first = await checkedAt();
  const r = await recordSystemHealth(pool, T, DOWN as any);
  const { rows } = await pool.query(
    `SELECT h.down_since::text AS since, o.started_at::text AS started
       FROM system_instance_health h JOIN instance_outages o ON o.instance = h.instance`,
  );
  assert.equal(rows[0].since, first); //   exatamente o instante da 1ª observação (µs)
  assert.equal(rows[0].started, first);
  assert.ok(Date.now() - r.downSince!.getTime() >= 4 * 60_000); // e não "agora"
});

test('CEDO DEMAIS: gravação colada na suspeita é ignorada — não abre, e NÃO renova o relógio', async () => {
  await recordSystemHealth(pool, T, DOWN as any);
  await age('20 seconds'); // dry-run do CLI, ou o tick imediato do 2º container de um rolling deploy
  const before = await checkedAt();
  const r = await recordSystemHealth(pool, T, { ...DOWN, state: 'connecting' } as any);

  assert.equal(r.downSince, null);
  assert.equal((await outages()).length, 0);
  // a linha ficou EXATAMENTE como estava: relógio e telemetria
  assert.equal(await checkedAt(), before);
  assert.equal((await pool.query(`SELECT last_state FROM system_instance_health`)).rows[0].last_state, 'close');

  // por não ter renovado o relógio, o tick de verdade, um intervalo depois, confirma
  await age('5 minutes');
  assert.notEqual((await recordSystemHealth(pool, T, DOWN as any)).downSince, null);
  assert.equal((await outages()).length, 1);
});

test('VELHA DEMAIS: suspeita de horas atrás (sondas com erro no meio) não é confirmada — recomeça', async () => {
  await recordSystemHealth(pool, T, DOWN as any);
  await age('4 hours'); // sonda com erro não toca a linha: a suspeita ficou parada
  const r = await recordSystemHealth(pool, T, DOWN as any);
  assert.equal(r.downSince, null);
  assert.equal((await outages()).length, 0);
  // recomeçou como primeira observação: o relógio é o de AGORA…
  const { rows } = await pool.query(
    `SELECT NOW() - checked_at < INTERVAL '5 seconds' AS fresh FROM system_instance_health`,
  );
  assert.equal(rows[0].fresh, true);
  // …e a confirmação volta a valer a partir daqui
  await age('5 minutes');
  assert.notEqual((await recordSystemHealth(pool, T, DOWN as any)).downSince, null);
  assert.equal((await outages()).length, 1);
});

test('duas sondas perdidas no meio (3 intervalos) ainda confirmam', async () => {
  await recordSystemHealth(pool, T, DOWN as any);
  await age('15 minutes');
  assert.notEqual((await recordSystemHealth(pool, T, DOWN as any)).downSince, null);
});

test('o intervalo do vigia dimensiona a janela: com tick de 1min, 5min já é velha demais', async () => {
  await recordSystemHealth(pool, T, DOWN as any, null, 60_000);
  await age('5 minutes');
  assert.equal((await recordSystemHealth(pool, T, DOWN as any, null, 60_000)).downSince, null);
  assert.equal((await outages()).length, 0);
});

test('flap de um tick (fora → saudável) não deixa rastro em instance_outages', async () => {
  await recordSystemHealth(pool, T, DOWN as any);
  await recordSystemHealth(pool, T, UP as any);
  await age('5 minutes');
  await recordSystemHealth(pool, T, DOWN as any);
  await recordSystemHealth(pool, T, UP as any);
  assert.equal((await outages()).length, 0);
});

test('início ESTIMADO vira observed_store e vence a 1ª observação', async () => {
  const observed = new Date('2026-09-09T18:10:00Z');
  await twoDownTicks(observed);
  const rows = await outages();
  assert.equal(rows[0].started_at_source, 'observed_store');
  assert.equal(rows[0].started_at.toISOString(), '2026-09-09T18:10:00.000Z');
});

test('ticks seguidos em queda NÃO abrem episódio novo', async () => {
  await twoDownTicks();
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

test('observações CONCORRENTES fora NÃO abrem episódio: três gravações no mesmo instante são UMA observação', async () => {
  await Promise.all([
    recordSystemHealth(pool, T, DOWN as any),
    recordSystemHealth(pool, T, DOWN as any),
    recordSystemHealth(pool, T, DOWN as any),
  ]);
  assert.equal((await outages()).length, 0);
  const { rows } = await pool.query(`SELECT last_reason, down_since FROM system_instance_health`);
  assert.deepEqual(rows[0], { last_reason: 'state', down_since: null });

  // …e concorrência NA HORA de confirmar segue produzindo um episódio só
  await age('5 minutes');
  await Promise.all([
    recordSystemHealth(pool, T, DOWN as any),
    recordSystemHealth(pool, T, DOWN as any),
    recordSystemHealth(pool, T, DOWN as any),
  ]);
  const after = await outages();
  assert.equal(after.length, 1);
  assert.equal(after[0].ended_at, null);
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
