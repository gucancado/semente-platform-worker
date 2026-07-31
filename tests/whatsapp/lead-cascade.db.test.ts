// tests/whatsapp/lead-cascade.db.test.ts  (roda no servidor/CI com DATABASE_URL)
//
// Prova as garantias transacionais da cascata não-lead (spec §4.8) que os testes
// puros não alcançam (Postgres real: lock + transação + CHECKs das opps):
//   1. Marcar não-lead fecha TODAS as opps abertas do par como perdido/nao_lead,
//      com is_qualified INTACTA e 2 eventos 'system' por opp.
//   2. Par com opp GANHA → rota devolve 409 possui_ganho e NADA muda (rollback):
//      nem a opp ganha, nem thread_meta (sem row nova), nem log.
//   3. Re-marcar not_lead idêntico → no-op sem log novo (guard de mudança efetiva).

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { setLeadStatus } from '../../src/whatsapp/thread-meta.js';
import { registerWriteRoutes } from '../../src/whatsapp/write-routes.js';

const TOKEN = 'tkn';
const passAuthz = { assertMember: async () => {}, assertAdmin: async () => {} };
function buildApp() {
  const app = Fastify({ logger: false });
  registerWriteRoutes(app, { pool, panelToken: TOKEN, authz: passAuthz });
  return app;
}

beforeEach(async () => {
  // whatsapp_numbers CASCADE cobre opportunities/events/thread_meta/thread_meta_log (todos FK→numbers).
  await pool.query(
    'TRUNCATE whatsapp_numbers, whatsapp_opportunities, whatsapp_opportunity_events, whatsapp_thread_meta, whatsapp_thread_meta_log RESTART IDENTITY CASCADE',
  );
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
});
after(() => pool.end());

/** Insere uma opp direto (controle preciso de status/is_qualified). Devolve o id. */
async function insertOpp(p: { status: string; isQualified: boolean | null }): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_opportunities
       (whatsapp_number_id, workspace_id, identifier, status, is_qualified, created_by)
     VALUES (1,'ws','c',$1,$2,'seed') RETURNING id`,
    [p.status, p.isQualified],
  );
  return Number(rows[0].id);
}

async function events(oppId: number): Promise<{ field: string; old_value: string | null; new_value: string | null; changed_by: string | null }[]> {
  const { rows } = await pool.query(
    `SELECT field, old_value, new_value, changed_by FROM whatsapp_opportunity_events
      WHERE opportunity_id=$1 ORDER BY id ASC`, [oppId]);
  return rows;
}

test('cascata fecha 2 opps abertas como perdido/nao_lead, is_qualified intacta, 2 eventos system cada', async () => {
  // Uma qualificada, uma indefinida — ambas em_andamento; prova intactness em 2 valores.
  const a = await insertOpp({ status: 'em_andamento', isQualified: true });
  const b = await insertOpp({ status: 'em_andamento', isQualified: null });

  await setLeadStatus(pool, { numberId: 1, identifier: 'c', isLead: false, updatedBy: 'u1' });

  const { rows } = await pool.query(
    `SELECT id, status, loss_reason, is_qualified, closed_at FROM whatsapp_opportunities WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [[a, b]]);
  for (const r of rows) {
    assert.equal(r.status, 'perdido');
    assert.equal(r.loss_reason, 'nao_lead');
    assert.ok(r.closed_at, 'closed_at setado');
  }
  // is_qualified INTACTA (a cascata não a toca).
  assert.equal(rows.find((r) => Number(r.id) === a)!.is_qualified, true);
  assert.equal(rows.find((r) => Number(r.id) === b)!.is_qualified, null);

  for (const id of [a, b]) {
    const ev = await events(id);
    assert.equal(ev.length, 2, 'exatamente 2 eventos (status + loss_reason)');
    assert.deepEqual(ev[0], { field: 'status', old_value: 'em_andamento', new_value: 'perdido', changed_by: 'system' });
    assert.deepEqual(ev[1], { field: 'loss_reason', old_value: null, new_value: 'nao_lead', changed_by: 'system' });
  }

  // Thread virou não-lead com 1 log.
  const meta = await pool.query(`SELECT is_lead FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier='c'`);
  assert.equal(meta.rows[0].is_lead, false);
  const log = await pool.query(`SELECT COUNT(*)::int AS n FROM whatsapp_thread_meta_log WHERE whatsapp_number_id=1 AND identifier='c' AND field='is_lead'`);
  assert.equal(Number(log.rows[0].n), 1);
});

test('par com opp ganha → rota 409 possui_ganho e NADA muda (rollback)', async () => {
  const ganho = await insertOpp({ status: 'ganho', isQualified: true });
  const openBefore = await insertOpp({ status: 'em_andamento', isQualified: null });

  const app = buildApp();
  const res = await app.inject({
    method: 'POST', url: '/whatsapp/threads/c/lead',
    headers: { 'x-panel-token': TOKEN, 'x-acting-user': 'u1' },
    payload: { number_id: 1, status: 'not_lead' },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'possui_ganho');
  await app.close();

  // Rollback total: ganha intacta, a em_andamento NÃO foi fechada, sem thread_meta, sem eventos, sem log.
  const g = await pool.query(`SELECT status FROM whatsapp_opportunities WHERE id=$1`, [ganho]);
  assert.equal(g.rows[0].status, 'ganho');
  const o = await pool.query(`SELECT status, loss_reason FROM whatsapp_opportunities WHERE id=$1`, [openBefore]);
  assert.equal(o.rows[0].status, 'em_andamento');
  assert.equal(o.rows[0].loss_reason, null);
  const meta = await pool.query(`SELECT COUNT(*)::int AS n FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier='c'`);
  assert.equal(Number(meta.rows[0].n), 0, 'nenhuma row de thread_meta gravada');
  const ev = await pool.query(`SELECT COUNT(*)::int AS n FROM whatsapp_opportunity_events`);
  assert.equal(Number(ev.rows[0].n), 0, 'nenhum evento de cascata');
  const log = await pool.query(`SELECT COUNT(*)::int AS n FROM whatsapp_thread_meta_log`);
  assert.equal(Number(log.rows[0].n), 0, 'nenhum log de thread');
});

test('re-marcar not_lead idêntico → no-op sem log novo', async () => {
  await setLeadStatus(pool, { numberId: 1, identifier: 'c', isLead: false, updatedBy: 'u1' });
  await setLeadStatus(pool, { numberId: 1, identifier: 'c', isLead: false, updatedBy: 'u2' }); // FALSE→FALSE

  const meta = await pool.query(`SELECT is_lead FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier='c'`);
  assert.equal(meta.rows[0].is_lead, false);
  const log = await pool.query(`SELECT COUNT(*)::int AS n FROM whatsapp_thread_meta_log WHERE whatsapp_number_id=1 AND identifier='c' AND field='is_lead'`);
  assert.equal(Number(log.rows[0].n), 1, 'só a 1ª marcação logou; a 2ª (idêntica) não');
});

test('marcar indefinido grava NULL (não TRUE) em is_lead', async () => {
  // Triagem 'indefinido' volta a conversa pra não-triado — NULL, distinto do default TRUE.
  await setLeadStatus(pool, { numberId: 1, identifier: 'c', isLead: null, updatedBy: 'u1' });
  const meta = await pool.query(`SELECT is_lead FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier='c'`);
  assert.equal(meta.rows[0].is_lead, null);
});
