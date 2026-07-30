/**
 * tests/whatsapp/auto-loss.db.test.ts  (roda no servidor/CI com DATABASE_URL)
 * SERVER-GATED: requires a live Postgres. Run ONE FILE AT A TIME.
 *
 * Prova o comportamento real do job de auto-perda (Fase B, Task B2) contra
 * Postgres — o que os testes puros (tests/auto-loss.test.ts) não alcançam
 * (candidatos reais via whatsapp_opportunities/messages, o GREATEST/COALESCE
 * do LEFT JOIN LATERAL quando não há NENHUMA mensagem, e o fechamento real via
 * patchOpportunityGuarded sob lock com CHECKs/eventos de verdade):
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
 *   7. Opp em thread not_lead (is_lead=FALSE) → não é candidata (minor 2 do
 *      review — simetria com o poller de criação, B1).
 *   8. Fix round 1 (Important do review): opp marcada GANHA por um humano
 *      DEPOIS do SELECT de candidatos mas ANTES do lock do patch (janela real
 *      de corrida, reproduzida deterministicamente contra Postgres via um pool
 *      proxy que injeta a escrita "humana" no meio do fluxo) → o guard recusa,
 *      a opp CONTINUA ganha, sem eventos/clobber do sweep.
 *   9. Fix round 2 (bloqueador do Gate B, achado do review Codex whole-phase):
 *      opp com created_at HISTÓRICO (perfil das ~444 migradas da v1) + mensagem
 *      antiga, mas `pipeline_since` do workspace é AGORA (cutover recente) →
 *      NÃO fecha — o piso do pipeline_since no GREATEST de 3 termos impede o
 *      fechamento em massa do legado logo no 1º tick pós-deploy.
 *  10. Mesma opp (9), mas `pipeline_since` 8 dias atrás (> auto_loss_days=7) →
 *      fecha normalmente — o piso deixa de proteger quando o próprio cutover já
 *      passou da janela.
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { runAutoLossSweep } from '../../src/whatsapp/auto-loss.js';
import { patchOpportunityV3 } from '../../src/whatsapp/opportunities.js';

const TRUNCATE = `TRUNCATE messages, whatsapp_numbers, whatsapp_opportunities, whatsapp_opportunity_events,
  whatsapp_workspace_settings, whatsapp_thread_meta, whatsapp_thread_meta_log RESTART IDENTITY CASCADE`;

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

/**
 * `pipelineSince` default é BEM antigo (2020) pra não interferir nos cenários
 * que não são sobre o piso do fix round 2 — nesses, o GREATEST de 3 termos é
 * dominado pela mensagem/created_at, exatamente como antes do fix. Os 2 testes
 * dedicados ao piso passam um `pipelineSince` explícito (recente ou 8d atrás).
 */
async function insertSettings(
  workspaceId: string, autoLossDays: number | null, pipelineSince: string = '2020-01-01T00:00:00Z',
): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_workspace_settings (workspace_id, auto_loss_days, pipeline_since) VALUES ($1,$2,$3)`,
    [workspaceId, autoLossDays, pipelineSince],
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

test('opp em thread not_lead (is_lead=FALSE) → não é candidata mesmo com atividade velha (minor 2 do review, simetria com o poller B1)', async () => {
  await insertNumber(7, 'ws7');
  await insertSettings('ws7', 7);
  await insertMsg({ numberId: 7, workspaceId: 'ws7', identifier: 'c7', createdAt: '2026-01-01T00:00:00Z', direction: 'inbound' });
  const oppId = await insertOpportunity({ numberId: 7, workspaceId: 'ws7', identifier: 'c7', createdAt: '2026-01-01T00:00:00Z' });
  await pool.query(`INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead) VALUES (7,'c7',FALSE)`);

  const r = await runAutoLossSweep(pool);
  assert.deepEqual(r, { closed: 0 });
  const opp = await getOpportunity(oppId);
  assert.equal(opp.status, 'em_andamento');
});

test('fix round 1 (Important do review): opp marcada GANHA por um humano entre o SELECT de candidatos e o lock do patch → guard recusa, opp CONTINUA ganha, sem clobber', async () => {
  await insertNumber(6, 'ws6');
  await insertSettings('ws6', 7);
  await insertMsg({ numberId: 6, workspaceId: 'ws6', identifier: 'c6', createdAt: '2026-01-01T00:00:00Z', direction: 'inbound' });
  const oppId = await insertOpportunity({ numberId: 6, workspaceId: 'ws6', identifier: 'c6', createdAt: '2026-01-01T00:00:00Z' });

  // Pool-proxy: deixa a query de candidatos rodar de VERDADE contra o Postgres
  // (acha a opp ainda em_andamento — é a janela ANTES da ação humana). Antes de
  // devolver o resultado pro sweep, injeta a ação humana real (marca ganho via
  // patchOpportunityV3, SEM guard, na mesma pool real) — reproduz
  // deterministicamente, contra Postgres de verdade, a janela de corrida entre
  // o SELECT de candidatos (fora do lock) e o momento em que o patch do sweep
  // toma o lock. Sem isso o teste dependeria de timing de Promise.all (flaky).
  let injected = false;
  const proxyPool = {
    query: (text: string, params?: any[]) => pool.query(text, params as any[]).then(async (res: any) => {
      if (!injected && /FROM whatsapp_opportunities o\b/.test(text)) {
        injected = true;
        const human = await patchOpportunityV3(pool, oppId, { status: 'ganho' }, 'human');
        assert.equal(human.ok, true, 'a marcação humana de ganho deve ter sucesso (opp ainda existe e está em_andamento)');
      }
      return res;
    }),
    connect: () => pool.connect(),
  } as any;

  const result = await runAutoLossSweep(proxyPool);
  assert.deepEqual(result, { closed: 0 }, 'o guard recusa — a opp já não é mais em_andamento quando o patch re-lê sob o lock');

  const opp = await getOpportunity(oppId);
  assert.equal(opp.status, 'ganho', 'a venda NÃO foi clobberada pra perdido');
  assert.equal(opp.loss_reason, null);

  const ev = await pool.query(
    `SELECT field FROM whatsapp_opportunity_events WHERE opportunity_id=$1 ORDER BY id`, [oppId],
  );
  assert.equal(ev.rows.some((r: any) => r.field === 'loss_reason'), false,
    'o sweep não deve ter gravado loss_reason — nenhuma escrita do lado do auto-loss');
});

test('fix round 2 (bloqueador do Gate B): opp com created_at HISTÓRICO (perfil do legado v1) + pipeline_since AGORA (cutover recente) → NÃO fecha em massa', async () => {
  await insertNumber(8, 'ws8');
  // pipeline_since = agora: simula o cutover acontecendo no momento do deploy.
  await insertSettings('ws8', 7, new Date().toISOString());
  // created_at e última mensagem BEM antigos — perfil exato das ~444 opps
  // migradas da v1 (created_at = thread.updated_at histórico da era pré-CRM).
  await insertMsg({ numberId: 8, workspaceId: 'ws8', identifier: 'c8', createdAt: '2020-01-01T00:00:00Z', direction: 'inbound' });
  const oppId = await insertOpportunity({ numberId: 8, workspaceId: 'ws8', identifier: 'c8', createdAt: '2020-01-01T00:00:00Z' });

  const r = await runAutoLossSweep(pool);
  assert.deepEqual(r, { closed: 0 }, 'pipeline_since recente domina o GREATEST de 3 termos — não é candidata ainda');
  const opp = await getOpportunity(oppId);
  assert.equal(opp.status, 'em_andamento', 'legado histórico não fecha em massa no 1º tick pós-deploy');
});

test('fix round 2: MESMA opp/mensagem históricas, mas pipeline_since 8 dias atrás (> auto_loss_days=7) → fecha normalmente', async () => {
  await insertNumber(9, 'ws9');
  const pipelineSince8dAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
  await insertSettings('ws9', 7, pipelineSince8dAgo);
  await insertMsg({ numberId: 9, workspaceId: 'ws9', identifier: 'c9', createdAt: '2020-01-01T00:00:00Z', direction: 'inbound' });
  const oppId = await insertOpportunity({ numberId: 9, workspaceId: 'ws9', identifier: 'c9', createdAt: '2020-01-01T00:00:00Z' });

  const r = await runAutoLossSweep(pool);
  assert.deepEqual(r, { closed: 1 }, 'o próprio pipeline_since já passou de auto_loss_days — o piso deixa de proteger');
  const opp = await getOpportunity(oppId);
  assert.equal(opp.status, 'perdido');
  assert.equal(opp.loss_reason, 'atendente_nao_respondeu'); // last_direction='inbound'
});
