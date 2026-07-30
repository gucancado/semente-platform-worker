/**
 * tests/whatsapp/auto-loss.db.test.ts  (roda no servidor/CI com DATABASE_URL)
 * SERVER-GATED: requires a live Postgres. Run ONE FILE AT A TIME.
 *
 * Prova o comportamento real do job de auto-perda (Fase B, Task B2) contra
 * Postgres — o que os testes puros (tests/auto-loss.test.ts) não alcançam
 * (candidatos reais via whatsapp_opportunities/messages, o GREATEST/COALESCE
 * do LEFT JOIN LATERAL quando não há NENHUMA mensagem, e o fechamento real via
 * patchOpportunityV3 sob lock com CHECKs/eventos de verdade):
 *   1. Opp aberta cuja última mensagem (inbound, velha) passou de auto_loss_days
 *      → fecha 'perdido'/'atendente_nao_respondeu' + exatamente 2 eventos
 *      (status, loss_reason), changed_by='system'.
 *   2. Opp com mensagem recente (dentro da janela) → intocada.
 *   3. Opp criada AGORA numa conversa dormente (mensagem velha, created_at
 *      recente) → intocada — prova o GREATEST (janela conta a partir da
 *      criação, não do histórico velho do par).
 *   4. Re-run sobre a opp já fechada em (1) → 0 (idempotente: status deixou de
 *      ser em_andamento, some da query de candidatos).
 *   5. Workspace com auto_loss_days=NULL (row existe, mas NULL) → intocado.
 *   6. Opp SEM mensagem nenhuma no par, criada há muito tempo → fecha
 *      'lead_nao_respondeu' (prova o fallback COALESCE(...,'epoch') quando o
 *      LEFT JOIN LATERAL não casa nenhuma row).
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { runAutoLossSweep } from '../../src/whatsapp/auto-loss.js';

const TRUNCATE = `TRUNCATE messages, whatsapp_numbers, whatsapp_opportunities, whatsapp_opportunity_events,
  whatsapp_workspace_settings RESTART IDENTITY CASCADE`;

beforeEach(async () => { await pool.query(TRUNCATE); });
after(() => pool.end());

async function insertNumber(id: number, workspaceId: string): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES ($1,$2,$3)`,
    [id, workspaceId, `inst-${id}`],
  );
}

async function insertMsg(o: {
  numberId: number; workspaceId: string; identifier: string; createdAt: string; direction: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at)
     VALUES ($1,$2,'whatsapp',$3,$4,'msg',$5)`,
    [o.numberId, o.workspaceId, o.identifier, o.direction, o.createdAt],
  );
}

async function insertSettings(workspaceId: string, autoLossDays: number | null): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_workspace_settings (workspace_id, auto_loss_days) VALUES ($1,$2)`,
    [workspaceId, autoLossDays],
  );
}

/** created_at explícito quando informado; senão usa o DEFAULT NOW() da tabela
 *  (necessário pro teste "criada AGORA numa conversa dormente"). */
async function insertOpportunity(o: {
  numberId: number; workspaceId: string; identifier: string; createdAt?: string;
}): Promise<number> {
  const { rows } = o.createdAt
    ? await pool.query(
      `INSERT INTO whatsapp_opportunities (whatsapp_number_id, workspace_id, identifier, status, created_by, created_at)
       VALUES ($1,$2,$3,'em_andamento','system',$4) RETURNING id`,
      [o.numberId, o.workspaceId, o.identifier, o.createdAt],
    )
    : await pool.query(
      `INSERT INTO whatsapp_opportunities (whatsapp_number_id, workspace_id, identifier, status, created_by)
       VALUES ($1,$2,$3,'em_andamento','system') RETURNING id`,
      [o.numberId, o.workspaceId, o.identifier],
    );
  return Number(rows[0].id);
}

async function getOpportunity(id: number) {
  const { rows } = await pool.query(
    `SELECT status, loss_reason, closed_at FROM whatsapp_opportunities WHERE id=$1`,
    [id],
  );
  return rows[0];
}

test('opp aberta com última msg inbound velha (fora da janela) → fecha atendente_nao_respondeu + 2 eventos system; re-run é idempotente', async () => {
  await insertNumber(1, 'ws');
  await insertSettings('ws', 7);
  await insertMsg({ numberId: 1, workspaceId: 'ws', identifier: 'c', createdAt: '2026-01-01T00:00:00Z', direction: 'inbound' });
  const oppId = await insertOpportunity({ numberId: 1, workspaceId: 'ws', identifier: 'c', createdAt: '2026-01-01T00:00:00Z' });

  const r1 = await runAutoLossSweep(pool);
  assert.deepEqual(r1, { closed: 1 });

  const opp = await getOpportunity(oppId);
  assert.equal(opp.status, 'perdido');
  assert.equal(opp.loss_reason, 'atendente_nao_respondeu');
  assert.ok(opp.closed_at, 'closed_at deve ser preenchido');

  const ev = await pool.query(
    `SELECT field, changed_by FROM whatsapp_opportunity_events WHERE opportunity_id=$1 ORDER BY id`,
    [oppId],
  );
  assert.equal(ev.rows.length, 2, 'status + loss_reason');
  assert.deepEqual(ev.rows.map((r: any) => r.field).sort(), ['loss_reason', 'status']);
  for (const row of ev.rows) assert.equal(row.changed_by, 'system');

  const r2 = await runAutoLossSweep(pool);
  assert.deepEqual(r2, { closed: 0 }, 'opp já perdida não é mais candidata (idempotente)');
  const oppAfter = await getOpportunity(oppId);
  assert.equal(oppAfter.status, 'perdido', 'não regrediu nem reabriu');
});

test('opp com mensagem recente (dentro da janela) → intocada', async () => {
  await insertNumber(2, 'ws2');
  await insertSettings('ws2', 7);
  const recent = new Date(Date.now() - 24 * 60 * 60_000).toISOString(); // 1 dia atrás
  await insertMsg({ numberId: 2, workspaceId: 'ws2', identifier: 'c2', createdAt: recent, direction: 'outbound' });
  const oppId = await insertOpportunity({ numberId: 2, workspaceId: 'ws2', identifier: 'c2', createdAt: '2026-01-01T00:00:00Z' });

  const r = await runAutoLossSweep(pool);
  assert.deepEqual(r, { closed: 0 });
  const opp = await getOpportunity(oppId);
  assert.equal(opp.status, 'em_andamento');
});

test('opp criada AGORA numa conversa dormente → intocada (GREATEST janela conta da criação, não do histórico velho)', async () => {
  await insertNumber(3, 'ws3');
  await insertSettings('ws3', 7);
  await insertMsg({ numberId: 3, workspaceId: 'ws3', identifier: 'c3', createdAt: '2026-01-01T00:00:00Z', direction: 'inbound' });
  const oppId = await insertOpportunity({ numberId: 3, workspaceId: 'ws3', identifier: 'c3' }); // created_at = NOW() (default)

  const r = await runAutoLossSweep(pool);
  assert.deepEqual(r, { closed: 0 });
  const opp = await getOpportunity(oppId);
  assert.equal(opp.status, 'em_andamento');
});

test('workspace com auto_loss_days=NULL → intocado', async () => {
  await insertNumber(4, 'ws4');
  await insertSettings('ws4', null);
  await insertMsg({ numberId: 4, workspaceId: 'ws4', identifier: 'c4', createdAt: '2026-01-01T00:00:00Z', direction: 'inbound' });
  const oppId = await insertOpportunity({ numberId: 4, workspaceId: 'ws4', identifier: 'c4', createdAt: '2026-01-01T00:00:00Z' });

  const r = await runAutoLossSweep(pool);
  assert.deepEqual(r, { closed: 0 });
  const opp = await getOpportunity(oppId);
  assert.equal(opp.status, 'em_andamento');
});

test('opp SEM mensagem nenhuma no par, criada há muito tempo → fecha lead_nao_respondeu (fallback COALESCE epoch)', async () => {
  await insertNumber(5, 'ws5');
  await insertSettings('ws5', 7);
  // Nenhuma insertMsg para este par — LEFT JOIN LATERAL não casa nenhuma row.
  const oppId = await insertOpportunity({ numberId: 5, workspaceId: 'ws5', identifier: 'c5', createdAt: '2026-01-01T00:00:00Z' });

  const r = await runAutoLossSweep(pool);
  assert.deepEqual(r, { closed: 1 });
  const opp = await getOpportunity(oppId);
  assert.equal(opp.status, 'perdido');
  assert.equal(opp.loss_reason, 'lead_nao_respondeu');
});
