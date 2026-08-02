// tests/opportunities-move.db.test.ts  (roda no servidor/CI com DATABASE_URL)
//
// Prova a transição de coluna transacional da rota `move` (DnD do kanban, §5/§10)
// contra Postgres real — o que os testes puros não alcançam (advisory lock +
// transação + CHECKs do schema v3). Board 4 colunas: perder saiu do move (é patch
// pela conversa); as 4 colunas são vivas → mover uma PERDIDA pra qualquer uma REABRE.
//   1. mover PERDIDA → negociacoes REABRE: em_andamento + qualificado + loss_reason
//      NULL + closed_at NULL + is_lead=TRUE na thread + eventos de transição.
//   2. mover PERDIDA (desqualificada) → interessados REABRE: em_andamento +
//      is_qualified NULL + loss_reason NULL + is_lead=TRUE (desqualificação limpa).
//   3. mover → novas_conversas rebaixa a thread pra NULL COM log (true→null).
//   4. no-op (opp já na coluna + thread no valor) não gera evento nem log.
//   5. thread log SÓ em mudança: negociacoes→interessados mantém is_lead=TRUE (sem
//      novo log), mudando só a qualificação da opp.
//
// NUNCA rodar contra prod (gate §14). Só toca as tabelas whatsapp_* truncadas.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { createOpportunityV3, patchOpportunityV3, moveOpportunity } from '../src/whatsapp/opportunities.js';

beforeEach(async () => {
  await pool.query(
    'TRUNCATE whatsapp_numbers, whatsapp_opportunities, whatsapp_opportunity_events, whatsapp_thread_meta, whatsapp_thread_meta_log RESTART IDENTITY CASCADE',
  );
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
});
after(() => pool.end());

async function newOpp(over: { isQualified?: boolean | null } = {}): Promise<number> {
  const opp = await createOpportunityV3(pool, {
    numberId: 1, workspaceId: 'ws', identifier: 'c', createdBy: 'u0', isQualified: over.isQualified ?? null,
  });
  assert.ok(opp, 'opp criada');
  return opp!.id;
}

const oppRow = async (id: number) =>
  (await pool.query(`SELECT status, is_qualified, loss_reason, closed_at FROM whatsapp_opportunities WHERE id=$1`, [id])).rows[0];
const threadLead = async () =>
  (await pool.query(`SELECT is_lead FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier='c'`)).rows[0];
const leadLogCount = async () =>
  Number((await pool.query(`SELECT COUNT(*)::int AS n FROM whatsapp_thread_meta_log WHERE whatsapp_number_id=1 AND identifier='c' AND field='is_lead'`)).rows[0].n);
async function countEvents(id: number, fields: string[]): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM whatsapp_opportunity_events WHERE opportunity_id=$1 AND field = ANY($2::text[])`, [id, fields]);
  return Number(rows[0].n);
}

test('mover PERDIDA → negociacoes reabre: em_andamento+qualificado, loss/closed NULL, thread TRUE, eventos', async () => {
  const id = await newOpp();
  // fecha como perdido com motivo
  await patchOpportunityV3(pool, id, { status: 'perdido', lossReason: 'lead_nao_respondeu' }, 'u1');

  const res = await moveOpportunity(pool, id, 'negociacoes', 'u2');
  if (!res.ok) throw new Error(`move falhou: ${res.error}`);
  assert.equal(res.column, 'negociacoes');
  assert.equal(res.moved, true);

  const row = await oppRow(id);
  assert.equal(row.status, 'em_andamento');
  assert.equal(row.is_qualified, true);
  assert.equal(row.loss_reason, null, 'reabertura limpa o motivo');
  assert.equal(row.closed_at, null, 'reabertura limpa closed_at');

  assert.equal((await threadLead()).is_lead, true, 'is_qualified TRUE cascateia is_lead=TRUE');
  assert.equal(await leadLogCount(), 1, 'thread logada 1x (ausente→true)');
  // move gerou status(perdido→em_andamento) + qualification(indefinido→qualificado) + loss_reason(→null)
  assert.equal(await countEvents(id, ['status']), 2, '1 fechamento + 1 reabertura');
  assert.equal(await countEvents(id, ['loss_reason']), 2, '1 ao fechar + 1 ao reabrir (limpa)');
});

test('mover PERDIDA (desqualificada) → interessados reabre: em_andamento + is_qualified NULL + loss NULL + thread TRUE', async () => {
  const id = await newOpp();
  // desqualifica: is_qualified=false ⇒ kernel fecha como perdido, com motivo.
  await patchOpportunityV3(pool, id, { isQualified: false, lossReason: 'lead_nao_respondeu' }, 'u1');

  const res = await moveOpportunity(pool, id, 'interessados', 'u2');
  if (!res.ok) throw new Error(`move falhou: ${res.error}`);
  assert.equal(res.column, 'interessados');
  assert.equal(res.moved, true);

  const row = await oppRow(id);
  assert.equal(row.status, 'em_andamento', 'reabriu');
  assert.equal(row.is_qualified, null, 'desqualificação limpa (volta a indefinido)');
  assert.equal(row.loss_reason, null, 'motivo limpo na reabertura');
  assert.equal(row.closed_at, null, 'reabertura limpa closed_at');

  assert.equal((await threadLead()).is_lead, true, 'interessados marca is_lead=TRUE na thread');
});

test('mover → novas_conversas rebaixa a thread pra NULL COM log', async () => {
  const id = await newOpp({ isQualified: true }); // cascata is_lead=TRUE + 1 log
  assert.equal((await threadLead()).is_lead, true);
  assert.equal(await leadLogCount(), 1);

  const res = await moveOpportunity(pool, id, 'novas_conversas', 'u1');
  if (!res.ok) throw new Error(`move falhou: ${res.error}`);
  assert.equal(res.column, 'novas_conversas');
  assert.equal(res.moved, true);

  assert.equal((await threadLead()).is_lead, null, 'is_lead rebaixado pra indefinido');
  const row = await oppRow(id);
  assert.equal(row.is_qualified, null);

  // novo log de is_lead: true→null
  const logs = await pool.query(
    `SELECT old_value, new_value FROM whatsapp_thread_meta_log
      WHERE whatsapp_number_id=1 AND identifier='c' AND field='is_lead' ORDER BY id`);
  assert.equal(logs.rows.length, 2, 'log ausente→true (create) + true→null (move)');
  assert.equal(logs.rows[1].old_value, 'true');
  assert.equal(logs.rows[1].new_value, null);
});

test('move no-op (já na coluna + thread no valor) → sem evento nem log', async () => {
  const id = await newOpp(); // em_andamento + is_qualified NULL + thread ausente = novas_conversas
  const res = await moveOpportunity(pool, id, 'novas_conversas', 'u1');
  if (!res.ok) throw new Error(`move falhou: ${res.error}`);
  assert.equal(res.moved, false);
  assert.equal(res.column, 'novas_conversas');

  // nenhum evento de transição além do 'created' original
  assert.equal(await countEvents(id, ['status', 'qualification', 'loss_reason']), 0);
  assert.equal(await leadLogCount(), 0, 'thread já indefinida não loga');
});

test('thread log SÓ em mudança: negociacoes→interessados mantém is_lead=TRUE sem novo log', async () => {
  const id = await newOpp({ isQualified: true }); // negociacoes: thread TRUE + 1 log
  assert.equal(await leadLogCount(), 1);

  const res = await moveOpportunity(pool, id, 'interessados', 'u1');
  if (!res.ok) throw new Error(`move falhou: ${res.error}`);
  assert.equal(res.column, 'interessados');
  assert.equal(res.moved, true, 'mudou a qualificação da opp');

  assert.equal((await threadLead()).is_lead, true, 'segue lead');
  assert.equal(await leadLogCount(), 1, 'is_lead já era TRUE → sem novo log');
  assert.equal((await oppRow(id)).is_qualified, null, 'desqualificação removida (volta a interessados)');
});
