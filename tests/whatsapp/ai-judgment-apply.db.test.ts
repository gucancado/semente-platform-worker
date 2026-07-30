/**
 * tests/whatsapp/ai-judgment-apply.db.test.ts  (roda no servidor/CI com DATABASE_URL)
 * SERVER-GATED: requires a live Postgres. Run ONE FILE AT A TIME. NUNCA contra prod.
 *
 * Prova o aplicador do julgamento IA (Task D4, spec v3 §7) end-to-end contra Postgres,
 * via buildJudgmentContext (D3) real + applyJudgment:
 *   1. Cenário completo: opp aberta + decisão (qualify + tag) → is_qualified=TRUE,
 *      thread.is_lead=TRUE (§4.2), tag_added(ai), 1 row em whatsapp_ai_judgments com
 *      `applied`; RE-RUN com snapshot fresco → already_judged (claim UNIQUE), sem
 *      duplicar nada.
 *   2. Stale: mensagem nova entre snapshot e aplicação → stale, nada escrito, 0 judgments.
 *   3. Triagem não-lead → cascata (opp perdido/loss_reason='nao_lead', eventos 'system'),
 *      thread.is_lead=FALSE, judgment gravado.
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { buildJudgmentContext } from '../../src/whatsapp/ai-judgment-context.js';
import { applyJudgment } from '../../src/whatsapp/ai-judgment-apply.js';
import type { JudgmentDecision } from '../../src/whatsapp/ai-judgment-prompt.js';

const TRUNCATE = `TRUNCATE messages, whatsapp_numbers, whatsapp_opportunities, whatsapp_opportunity_events,
  whatsapp_opportunity_tags, whatsapp_tags, whatsapp_thread_meta, whatsapp_thread_meta_log,
  whatsapp_ai_judgments, whatsapp_loss_reasons, whatsapp_workspace_settings RESTART IDENTITY CASCADE`;

beforeEach(async () => { await pool.query(TRUNCATE); });
after(() => pool.end());

async function insertNumber(id: number, ws: string): Promise<void> {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES ($1,$2,$3)`, [id, ws, `inst-${id}`]);
}
async function insertMsg(o: { numberId: number; ws: string; identifier: string; createdAt: string; direction?: string }): Promise<void> {
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
     VALUES ($1,$2,'whatsapp',$3,$4,'msg',$5)`,
    [o.numberId, o.ws, o.identifier, o.direction ?? 'inbound', o.createdAt],
  );
}
async function insertOpenOpp(o: { numberId: number; ws: string; identifier: string }): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_opportunities (whatsapp_number_id, workspace_id, identifier, status, is_qualified, created_by)
     VALUES ($1,$2,$3,'em_andamento',NULL,'system') RETURNING id`,
    [o.numberId, o.ws, o.identifier],
  );
  return Number(rows[0].id);
}
async function insertTag(ws: string, name: string): Promise<number> {
  const { rows } = await pool.query(`INSERT INTO whatsapp_tags (workspace_id, name, color) VALUES ($1,$2,'honey') RETURNING id`, [ws, name]);
  return Number(rows[0].id);
}
async function markLead(numberId: number, identifier: string, isLead: boolean | null): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead, updated_by) VALUES ($1,$2,$3,'system')
     ON CONFLICT (whatsapp_number_id, identifier) DO UPDATE SET is_lead = EXCLUDED.is_lead`,
    [numberId, identifier, isLead],
  );
}
const buildCtx = (numberId: number, ws: string, identifier: string) =>
  buildJudgmentContext(pool, { numberId, identifier, workspaceId: ws, watermark: null });

test('cenário completo: qualify + tag aplicados; re-run com snapshot fresco → already_judged sem duplicar', async () => {
  await insertNumber(1, 'ws');
  await markLead(1, 'c', true);
  await insertOpenOpp({ numberId: 1, ws: 'ws', identifier: 'c' });
  await insertMsg({ numberId: 1, ws: 'ws', identifier: 'c', createdAt: '2026-07-30T10:00:00Z' });
  const tagId = await insertTag('ws', 'plano_saude');

  const ctx = await buildCtx(1, 'ws', 'c');
  const decision: JudgmentDecision = {
    triage: null, notLeadReason: null,
    openOpp: { qualify: true, status: null, lossReason: null },
    closedAction: null, tags: [tagId], rationale: 'fit claro',
  };

  const res = await applyJudgment(pool, ctx, decision, { model: 'm1' });
  assert.equal(res.stale, false);
  assert.ok(res.applied.includes('qualify:true'));
  assert.ok(res.applied.includes(`tag:${tagId}`));

  const opp = await pool.query(`SELECT is_qualified FROM whatsapp_opportunities WHERE whatsapp_number_id=1 AND identifier='c'`);
  assert.equal(opp.rows[0].is_qualified, true);
  const meta = await pool.query(`SELECT is_lead FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier='c'`);
  assert.equal(meta.rows[0].is_lead, true, '§4.2: qualificar implica lead');
  const tagAdded = await pool.query(`SELECT changed_by FROM whatsapp_opportunity_events WHERE field='tag_added'`);
  assert.equal(tagAdded.rows.length, 1);
  assert.equal(tagAdded.rows[0].changed_by, 'ai');
  const judg = await pool.query(`SELECT applied, model FROM whatsapp_ai_judgments`);
  assert.equal(judg.rows.length, 1);
  assert.equal(judg.rows[0].model, 'm1');
  assert.deepEqual(judg.rows[0].applied.applied.sort(), [`tag:${tagId}`, 'qualify:true'].sort());

  // RE-RUN: snapshot fresco (mesmo lastMessageAt → mesmo watermark) → claim conflita.
  const ctx2 = await buildCtx(1, 'ws', 'c');
  const res2 = await applyJudgment(pool, ctx2, decision, { model: 'm1' });
  assert.deepEqual(res2, { applied: [], skipped: ['already_judged'], stale: false });
  const judg2 = await pool.query(`SELECT count(*)::int AS n FROM whatsapp_ai_judgments`);
  assert.equal(judg2.rows[0].n, 1, 'não cria 2ª row de julgamento');
  const tags2 = await pool.query(`SELECT count(*)::int AS n FROM whatsapp_opportunity_tags`);
  assert.equal(tags2.rows[0].n, 1, 'não re-aplica a tag');
});

test('stale: mensagem nova entre snapshot e aplicação → stale, nada escrito', async () => {
  await insertNumber(1, 'ws');
  await markLead(1, 'c', true);
  await insertOpenOpp({ numberId: 1, ws: 'ws', identifier: 'c' });
  await insertMsg({ numberId: 1, ws: 'ws', identifier: 'c', createdAt: '2026-07-30T10:00:00Z' });

  const ctx = await buildCtx(1, 'ws', 'c');
  // chega mensagem nova DEPOIS de montar o snapshot
  await insertMsg({ numberId: 1, ws: 'ws', identifier: 'c', createdAt: '2026-07-30T11:00:00Z' });

  const res = await applyJudgment(pool, ctx, {
    triage: null, notLeadReason: null, openOpp: { qualify: true, status: null, lossReason: null },
    closedAction: null, tags: [], rationale: 'x',
  }, {});
  assert.deepEqual(res, { applied: [], skipped: [], stale: true });
  const opp = await pool.query(`SELECT is_qualified FROM whatsapp_opportunities WHERE whatsapp_number_id=1 AND identifier='c'`);
  assert.equal(opp.rows[0].is_qualified, null, 'não qualificou');
  const judg = await pool.query(`SELECT count(*)::int AS n FROM whatsapp_ai_judgments`);
  assert.equal(judg.rows[0].n, 0, 'stale não grava judgment');
});

test('triagem não-lead → cascata (opp perdido/nao_lead, eventos system) + thread is_lead=FALSE + judgment', async () => {
  await insertNumber(1, 'ws');
  await markLead(1, 'c', null); // indefinido: prompt pede triagem
  await insertOpenOpp({ numberId: 1, ws: 'ws', identifier: 'c' });
  await insertMsg({ numberId: 1, ws: 'ws', identifier: 'c', createdAt: '2026-07-30T10:00:00Z' });

  const ctx = await buildCtx(1, 'ws', 'c');
  const res = await applyJudgment(pool, ctx, {
    triage: 'not_lead', notLeadReason: null, openOpp: null, closedAction: null, tags: [], rationale: 'spam',
  }, {});
  assert.equal(res.stale, false);
  assert.ok(res.applied.includes('triage:not_lead'));

  const meta = await pool.query(`SELECT is_lead FROM whatsapp_thread_meta WHERE whatsapp_number_id=1 AND identifier='c'`);
  assert.equal(meta.rows[0].is_lead, false);
  const opp = await pool.query(`SELECT status, loss_reason FROM whatsapp_opportunities WHERE whatsapp_number_id=1 AND identifier='c'`);
  assert.equal(opp.rows[0].status, 'perdido');
  assert.equal(opp.rows[0].loss_reason, 'nao_lead');
  const casc = await pool.query(`SELECT DISTINCT changed_by FROM whatsapp_opportunity_events WHERE field IN ('status','loss_reason')`);
  assert.deepEqual(casc.rows.map((r) => r.changed_by), ['system'], 'eventos da cascata são system');
  const leadLog = await pool.query(`SELECT actor, new_value FROM whatsapp_thread_meta_log WHERE field='is_lead'`);
  assert.equal(leadLog.rows.length, 1);
  assert.equal(leadLog.rows[0].actor, 'ai');
  assert.equal(leadLog.rows[0].new_value, 'false');
  const judg = await pool.query(`SELECT count(*)::int AS n FROM whatsapp_ai_judgments`);
  assert.equal(judg.rows[0].n, 1);
});
