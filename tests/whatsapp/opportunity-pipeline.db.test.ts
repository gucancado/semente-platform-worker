/**
 * tests/whatsapp/opportunity-pipeline.db.test.ts  (roda no servidor/CI com DATABASE_URL)
 * SERVER-GATED: requires a live Postgres. Run ONE FILE AT A TIME.
 *
 * Prova o comportamento real do poller de criação (Fase B, Task B1) contra
 * Postgres — o que os testes puros (tests/opportunity-pipeline.test.ts) não
 * alcançam (candidatos reais via messages/whatsapp_thread_meta/whatsapp_groups
 * + a re-checagem transacional de createOpportunityV3):
 *   1. Par DM virgem com mensagem > pipeline_since → cria exatamente 1 opp
 *      em_andamento/is_qualified NULL/created_by='system' + 1 evento 'created';
 *      um 2º sweep NÃO recria (o par já tem opp).
 *   2. Par explicitamente not_lead (is_lead=FALSE) → 0 candidatos.
 *   3. Par de grupo — via row em whatsapp_groups OU via mensagem com author —
 *      → 0 candidatos (nos dois detectores do padrão canônico).
 *   4. Mensagem anterior a pipeline_since → 0 candidatos (não retroage).
 *   5. Workspace sem row em whatsapp_workspace_settings fica de fora do sweep.
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { runCreationSweep } from '../../src/whatsapp/opportunity-pipeline.js';

const TRUNCATE = `TRUNCATE messages, whatsapp_numbers, whatsapp_opportunities, whatsapp_opportunity_events,
  whatsapp_thread_meta, whatsapp_groups, whatsapp_workspace_settings RESTART IDENTITY CASCADE`;

beforeEach(async () => { await pool.query(TRUNCATE); });
after(() => pool.end());

async function insertNumber(id: number, workspaceId: string): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES ($1,$2,$3)`,
    [id, workspaceId, `inst-${id}`],
  );
}

async function insertMsg(o: {
  numberId: number; workspaceId: string; identifier: string; createdAt: string;
  direction?: string; author?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO messages (whatsapp_number_id, workspace_id, channel, identifier, direction, text, created_at, author)
     VALUES ($1,$2,'whatsapp',$3,$4,'msg',$5,$6)`,
    [o.numberId, o.workspaceId, o.identifier, o.direction ?? 'inbound', o.createdAt, o.author ?? null],
  );
}

async function insertSettings(workspaceId: string, pipelineSince: string): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_workspace_settings (workspace_id, pipeline_since) VALUES ($1,$2)`,
    [workspaceId, pipelineSince],
  );
}

async function oppCount(numberId: number, identifier: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM whatsapp_opportunities WHERE whatsapp_number_id=$1 AND identifier=$2`,
    [numberId, identifier],
  );
  return Number(rows[0].n);
}

test('par DM virgem com mensagem > pipeline_since → cria 1 opp em_andamento/indefinida/system + evento created; 2º sweep não recria', async () => {
  await insertNumber(1, 'ws');
  await insertSettings('ws', '2026-07-01T00:00:00Z');
  await insertMsg({ numberId: 1, workspaceId: 'ws', identifier: 'c', createdAt: '2026-07-15T00:00:00Z' });

  const r1 = await runCreationSweep(pool);
  assert.deepEqual(r1, { created: 1, skipped: 0 });

  const opp = await pool.query(
    `SELECT id, status, is_qualified, created_by FROM whatsapp_opportunities WHERE whatsapp_number_id=1 AND identifier='c'`,
  );
  assert.equal(opp.rows.length, 1);
  assert.equal(opp.rows[0].status, 'em_andamento');
  assert.equal(opp.rows[0].is_qualified, null);
  assert.equal(opp.rows[0].created_by, 'system');

  const ev = await pool.query(
    `SELECT field FROM whatsapp_opportunity_events WHERE opportunity_id=$1`,
    [opp.rows[0].id],
  );
  assert.equal(ev.rows.length, 1);
  assert.equal(ev.rows[0].field, 'created');

  const r2 = await runCreationSweep(pool);
  assert.deepEqual(r2, { created: 0, skipped: 0 }, '2º sweep: o par já tem opp, não é mais candidato');
  assert.equal(await oppCount(1, 'c'), 1, 'não duplicou');
});

test('par not_lead (is_lead=FALSE) → 0 candidatos, nenhuma opp criada', async () => {
  await insertNumber(1, 'ws');
  await insertSettings('ws', '2026-07-01T00:00:00Z');
  await insertMsg({ numberId: 1, workspaceId: 'ws', identifier: 'c', createdAt: '2026-07-15T00:00:00Z' });
  await pool.query(`INSERT INTO whatsapp_thread_meta (whatsapp_number_id, identifier, is_lead) VALUES (1,'c',FALSE)`);

  const r = await runCreationSweep(pool);
  assert.deepEqual(r, { created: 0, skipped: 0 });
  assert.equal(await oppCount(1, 'c'), 0);
});

test('par de grupo (row em whatsapp_groups pelo jid) → 0 candidatos', async () => {
  await insertNumber(1, 'ws');
  await insertSettings('ws', '2026-07-01T00:00:00Z');
  await insertMsg({ numberId: 1, workspaceId: 'ws', identifier: 'g1', createdAt: '2026-07-15T00:00:00Z' });
  await pool.query(
    `INSERT INTO whatsapp_groups (jid, subject, whatsapp_number_id, workspace_id) VALUES ($1,$2,$3,$4)`,
    ['g1', 'Grupo', 1, 'ws'],
  );

  const r = await runCreationSweep(pool);
  assert.deepEqual(r, { created: 0, skipped: 0 });
  assert.equal(await oppCount(1, 'g1'), 0);
});

test('par de grupo (mensagem do par com author preenchido) → 0 candidatos', async () => {
  await insertNumber(1, 'ws');
  await insertSettings('ws', '2026-07-01T00:00:00Z');
  await insertMsg({
    numberId: 1, workspaceId: 'ws', identifier: 'g2', createdAt: '2026-07-15T00:00:00Z',
    author: '+5511999999999',
  });

  const r = await runCreationSweep(pool);
  assert.deepEqual(r, { created: 0, skipped: 0 });
  assert.equal(await oppCount(1, 'g2'), 0);
});

test('mensagem anterior a pipeline_since → 0 candidatos (não retroage sobre histórico pré-pipeline)', async () => {
  await insertNumber(1, 'ws');
  await insertSettings('ws', '2026-07-10T00:00:00Z');
  await insertMsg({ numberId: 1, workspaceId: 'ws', identifier: 'c', createdAt: '2026-07-05T00:00:00Z' });

  const r = await runCreationSweep(pool);
  assert.deepEqual(r, { created: 0, skipped: 0 });
  assert.equal(await oppCount(1, 'c'), 0);
});

test('workspace sem row em whatsapp_workspace_settings fica de fora do sweep', async () => {
  await insertNumber(1, 'ws-sem-settings');
  await insertMsg({ numberId: 1, workspaceId: 'ws-sem-settings', identifier: 'c', createdAt: '2026-07-15T00:00:00Z' });
  // Nenhum insertSettings para este workspace — não deve gerar candidato nenhum.

  const r = await runCreationSweep(pool);
  assert.deepEqual(r, { created: 0, skipped: 0 });
  assert.equal(await oppCount(1, 'c'), 0);
});
