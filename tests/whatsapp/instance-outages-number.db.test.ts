// tests/whatsapp/instance-outages-number.db.test.ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import {
  updateNumberStatus, upsertConnectedNumber, getNumberByInstance,
  setNumberLifecycle, claimNumberByPhone,
} from '../../src/whatsapp/numbers.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers, instance_outages RESTART IDENTITY CASCADE');
});
after(() => pool.end());

const seed = () => upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: 'i-1', phone: '+5531999', createdBy: null });
const openCount = async () => (await pool.query(`SELECT count(*)::int c FROM instance_outages WHERE ended_at IS NULL`)).rows[0].c;

test('connected → disconnected ABRE episódio', async () => {
  await seed();
  await updateNumberStatus(pool, 'i-1', { status: 'disconnected' });
  const { rows } = await pool.query(`SELECT * FROM instance_outages WHERE instance='i-1'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'number');
  assert.equal(rows[0].started_at_source, 'webhook');
  assert.equal(rows[0].ended_at, null);
  assert.notEqual(rows[0].number_id, null);
});

test('disconnected → connecting NÃO abre um segundo', async () => {
  await seed();
  await updateNumberStatus(pool, 'i-1', { status: 'disconnected' });
  await updateNumberStatus(pool, 'i-1', { status: 'connecting' });
  assert.equal(await openCount(), 1);
});

test('reconexão FECHA o episódio', async () => {
  await seed();
  await updateNumberStatus(pool, 'i-1', { status: 'disconnected' });
  await updateNumberStatus(pool, 'i-1', { status: 'connected' });
  assert.equal(await openCount(), 0);
  const { rows } = await pool.query(`SELECT ended_at FROM instance_outages WHERE instance='i-1'`);
  assert.notEqual(rows[0].ended_at, null);
});

test('ATALHO: upsertConnectedNumber (reprovisionamento) também FECHA', async () => {
  // Este é o caminho que deixaria episódio órfão para sempre: ele grava
  // status='connected' direto no ON CONFLICT, sem passar por updateNumberStatus.
  // Com a linha aberta, toda queda futura seria engolida pelo DO NOTHING.
  await seed();
  await updateNumberStatus(pool, 'i-1', { status: 'disconnected' });
  await seed();
  assert.equal(await openCount(), 0);
});

test('instância sem episódio aberto: reconectar é no-op', async () => {
  await seed();
  await updateNumberStatus(pool, 'i-1', { status: 'connected' });
  assert.equal((await pool.query(`SELECT count(*)::int c FROM instance_outages`)).rows[0].c, 0);
});

test('REMOVER (removed:true) fecha o episódio — a instância deixou de existir', async () => {
  await seed();
  await updateNumberStatus(pool, 'i-1', { status: 'disconnected' });
  const n = await getNumberByInstance(pool, 'i-1');
  await setNumberLifecycle(pool, n!.id, { status: 'disconnected', removed: true });
  assert.equal(await openCount(), 0);
});

test('DESCONECTAR (removed:false) NÃO fecha — é o início da janela, não o fim', async () => {
  // `provision-routes.ts:358` só faz logoutInstance e MANTÉM a instância para
  // reconectar sem perder histórico: o observador para de capturar com a
  // instância viva. Fechar aqui afirmaria "monitoramento retomado" no instante
  // exato em que ele parou — e apagaria da conversa o buraco que começa agora.
  await seed();
  await updateNumberStatus(pool, 'i-1', { status: 'disconnected' });
  const n = await getNumberByInstance(pool, 'i-1');
  await setNumberLifecycle(pool, n!.id, { status: 'disconnected', removed: false });
  assert.equal(await openCount(), 1, 'o episódio segue aberto');
});

test('claimNumberByPhone fecha o episódio da instância ANTIGA', async () => {
  // Caminho real: o número caiu (episódio aberto), e depois foi reprovisionado
  // em outro workspace, ganhando instância nova. A antiga nunca mais captura.
  // ⚠️ Se o ramo "moved" de `claimNumberByPhone` exigir precondições diferentes
  // das usadas aqui, ajuste o FIXTURE — nunca a asserção.
  await seed();
  await updateNumberStatus(pool, 'i-1', { status: 'disconnected' });
  assert.equal(await openCount(), 1);
  await claimNumberByPhone(pool, {
    phone: '+5531999', newWorkspaceId: 'ws-2', evolutionInstance: 'i-2',
  });
  const { rows } = await pool.query(
    `SELECT ended_at FROM instance_outages WHERE instance = 'i-1'`,
  );
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].ended_at, null, 'episódio da instância antiga foi fechado');
});
