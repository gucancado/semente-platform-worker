// tests/opportunities-v3.db.test.ts  (roda no servidor/CI com DATABASE_URL)
//
// Prova as garantias transacionais do data layer v3 que os testes puros não
// alcançam (precisam de Postgres real: advisory lock + transação):
//   1. Dois patches simultâneos na MESMA conversa serializam pelo lock — o 2º
//      relê o estado fresco (mata o stale-snapshot do v2): estado final
//      determinístico (ganho) e exatamente 2 eventos de transição (a 2ª chamada
//      vira no-op ao ver a opp já ganha).
//   2. Qualificar cascateia is_lead=TRUE na thread e loga 1x.
//   3. Re-patch idêntico NÃO loga a thread de novo (guard do sticky da IA).

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { createOpportunityV3, patchOpportunityV3 } from '../src/whatsapp/opportunities.js';

beforeEach(async () => {
  // whatsapp_numbers CASCADE cobre opportunities/events/thread_meta/thread_meta_log (todos FK→numbers).
  await pool.query(
    'TRUNCATE whatsapp_numbers, whatsapp_opportunities, whatsapp_opportunity_events, whatsapp_thread_meta, whatsapp_thread_meta_log RESTART IDENTITY CASCADE',
  );
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
});
after(() => pool.end());

async function newOpp(over: { isQualified?: boolean | null } = {}) {
  const opp = await createOpportunityV3(pool, {
    numberId: 1, workspaceId: 'ws', identifier: 'c', createdBy: 'u0',
    isQualified: over.isQualified ?? null,
  });
  assert.ok(opp, 'opp criada');
  return opp!.id;
}

async function countEvents(id: number, fields: string[]): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM whatsapp_opportunity_events WHERE opportunity_id=$1 AND field = ANY($2::text[])`,
    [id, fields]);
  return Number(rows[0].n);
}

test('2 patches ganho simultâneos serializam: estado determinístico + 2 eventos', async () => {
  const id = await newOpp();

  const [a, b] = await Promise.all([
    patchOpportunityV3(pool, id, { status: 'ganho' }, 'u1'),
    patchOpportunityV3(pool, id, { status: 'ganho' }, 'u2'),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const { rows } = await pool.query(
    `SELECT status, is_qualified, closed_at FROM whatsapp_opportunities WHERE id=$1`, [id]);
  assert.equal(rows[0].status, 'ganho');
  assert.equal(rows[0].is_qualified, true);
  assert.ok(rows[0].closed_at, 'closed_at setado');

  // Só a 1ª transição real gera eventos (status + qualification); a 2ª chamada
  // relê ganho e vira no-op. Sem o lock haveria eventos duplicados / lost update.
  assert.equal(await countEvents(id, ['status', 'qualification']), 2);
  assert.equal(await countEvents(id, ['created']), 1);
});

test('qualificar cascateia is_lead=TRUE na thread e loga 1x', async () => {
  const id = await newOpp();

  const res = await patchOpportunityV3(pool, id, { isQualified: true }, 'u1');
  assert.equal(res.ok, true);

  const meta = await pool.query(
    `SELECT is_lead FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier='c'`);
  assert.equal(meta.rows[0].is_lead, true);

  const log = await pool.query(
    `SELECT old_value, new_value FROM whatsapp_thread_meta_log
      WHERE whatsapp_number_id=1 AND identifier='c' AND field='is_lead'`);
  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0].old_value, null);
  assert.equal(log.rows[0].new_value, 'true');
});

test('re-patch idêntico não loga a thread de novo', async () => {
  const id = await newOpp();

  await patchOpportunityV3(pool, id, { isQualified: true }, 'u1');
  await patchOpportunityV3(pool, id, { isQualified: true }, 'u1'); // no-op de opp, side-effect idempotente

  const log = await pool.query(
    `SELECT COUNT(*)::int AS n FROM whatsapp_thread_meta_log
      WHERE whatsapp_number_id=1 AND identifier='c' AND field='is_lead'`);
  assert.equal(Number(log.rows[0].n), 1, 'is_lead já era TRUE → 2ª chamada não loga');
});

test('createOpportunityV3 com isQualified=true cascateia is_lead=TRUE + 1 log', async () => {
  const opp = await createOpportunityV3(pool, { numberId: 1, workspaceId: 'ws', identifier: 'c', isQualified: true, createdBy: 'u1' });
  assert.ok(opp);
  assert.equal(opp!.isQualified, true);

  const meta = await pool.query(`SELECT is_lead FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier='c'`);
  assert.equal(meta.rows[0].is_lead, true);

  const log = await pool.query(
    `SELECT old_value, new_value FROM whatsapp_thread_meta_log WHERE whatsapp_number_id=1 AND identifier='c' AND field='is_lead'`);
  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0].old_value, null);
  assert.equal(log.rows[0].new_value, 'true');
});

test('createOpportunityV3 com isQualified=true em thread já lead não loga de novo', async () => {
  await pool.query(`INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead, updated_by) VALUES (1,'c',TRUE,'seed')`);
  const opp = await createOpportunityV3(pool, { numberId: 1, workspaceId: 'ws', identifier: 'c', isQualified: true, createdBy: 'u1' });
  assert.ok(opp);

  const log = await pool.query(
    `SELECT COUNT(*)::int AS n FROM whatsapp_thread_meta_log WHERE whatsapp_number_id=1 AND identifier='c' AND field='is_lead'`);
  assert.equal(Number(log.rows[0].n), 0, 'is_lead já era TRUE → create não loga');
});

test('patch em opp inexistente devolve not_found', async () => {
  const res = await patchOpportunityV3(pool, 999999, { status: 'ganho' }, 'u1');
  assert.deepEqual(res, { ok: false, error: 'not_found' });
});

test('desqualificar uma ganha devolve desqualificar_ganho (não lança)', async () => {
  const id = await newOpp();
  await patchOpportunityV3(pool, id, { status: 'ganho' }, 'u1');
  const res = await patchOpportunityV3(pool, id, { isQualified: false }, 'u1');
  assert.deepEqual(res, { ok: false, error: 'desqualificar_ganho' });
});
