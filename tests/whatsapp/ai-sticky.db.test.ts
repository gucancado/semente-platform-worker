// tests/whatsapp/ai-sticky.db.test.ts  (roda no servidor/CI com DATABASE_URL)
//
// Prova a precedência humana por dimensão (spec v3 §6) contra Postgres real:
// semeia logs/eventos com atores VARIADOS (humano, ai, system, migration, NULL) e
// confere que só o humano trava — nas 5 dimensões (is_lead, is_qualified, status,
// loss_reason, tags) + o corte por opportunityId null.
//
// NUNCA rodar contra prod. TRUNCATE agressivo no beforeEach.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { computeSticky } from '../../src/whatsapp/ai-sticky.js';

beforeEach(async () => {
  // whatsapp_numbers CASCADE cobre opportunities/events/thread_meta/thread_meta_log (FK→numbers/opp).
  await pool.query(
    'TRUNCATE whatsapp_numbers, whatsapp_opportunities, whatsapp_opportunity_events, whatsapp_thread_meta, whatsapp_thread_meta_log RESTART IDENTITY CASCADE',
  );
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws','i')`);
});
after(() => pool.end());

/** Insere uma opp em_andamento indefinida; devolve o id. */
async function insertOpp(identifier = 'c'): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_opportunities
       (whatsapp_number_id, workspace_id, identifier, status, is_qualified, created_by)
     VALUES (1,'ws',$1,'em_andamento',NULL,'seed') RETURNING id`,
    [identifier],
  );
  return Number(rows[0].id);
}

async function logLead(identifier: string, actor: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_thread_meta_log (whatsapp_number_id, identifier, field, old_value, new_value, actor)
     VALUES (1, $1, 'is_lead', NULL, 'true', $2)`,
    // actor é NOT NULL no schema; NULL só é alcançável por dados legados — cobrimos
    // o ramo NULL no teste puro. Aqui exercitamos os atores reais gravados hoje.
    [identifier, actor ?? 'system'],
  );
}

async function event(oppId: number, field: string, newValue: string | null, changedBy: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_opportunity_events (opportunity_id, field, old_value, new_value, changed_by)
     VALUES ($1, $2, NULL, $3, $4)`,
    [oppId, field, newValue, changedBy],
  );
}

test('is_lead: só ator humano trava; ai/system/migration não', async () => {
  // Thread A: log humano → trava. Thread B: só ai/system/migration → não trava.
  await logLead('a', 'u1');
  await logLead('b', 'ai');
  await logLead('b', 'system');
  await logLead('b', 'migration');

  const a = await computeSticky(pool, { numberId: 1, identifier: 'a', opportunityId: null });
  const b = await computeSticky(pool, { numberId: 1, identifier: 'b', opportunityId: null });
  assert.equal(a.isLead, true);
  assert.equal(b.isLead, false);
});

test('is_lead NULL do driver (EXISTS falso) → não trava', async () => {
  const flags = await computeSticky(pool, { numberId: 1, identifier: 'sem-log', opportunityId: null });
  assert.equal(flags.isLead, false);
});

test('opp: qualification/status/loss_reason travam só com evento humano', async () => {
  const opp = await insertOpp();
  await event(opp, 'qualification', 'qualificado', 'u1'); // humano → trava
  await event(opp, 'status', 'perdido', 'ai');            // ai → não trava
  await event(opp, 'loss_reason', 'preco', 'system');     // system → não trava

  const f = await computeSticky(pool, { numberId: 1, identifier: 'c', opportunityId: opp });
  assert.equal(f.isQualified, true);
  assert.equal(f.status, false);
  assert.equal(f.lossReason, false);
  assert.deepEqual(f.tagsRemovedByHuman, []);
});

test('opp: todas as dimensões humanas travam juntas', async () => {
  const opp = await insertOpp();
  await event(opp, 'qualification', 'desqualificado', 'u1');
  await event(opp, 'status', 'perdido', 'u2');
  await event(opp, 'loss_reason', 'sem_interesse', 'u1');

  const f = await computeSticky(pool, { numberId: 1, identifier: 'c', opportunityId: opp });
  assert.equal(f.isQualified, true);
  assert.equal(f.status, true);
  assert.equal(f.lossReason, true);
});

test('tag_removed: só nomes removidos por humano, DISTINCT; ai/system fora', async () => {
  const opp = await insertOpp();
  await event(opp, 'tag_removed', 'VIP', 'u1');       // humano
  await event(opp, 'tag_removed', 'VIP', 'u2');       // humano, mesmo nome → DISTINCT
  await event(opp, 'tag_removed', 'urgente', 'u1');   // humano
  await event(opp, 'tag_removed', 'spam', 'ai');      // ai → fora
  await event(opp, 'tag_removed', 'auto', 'system');  // system → fora
  await event(opp, 'tag_added', 'novo', 'u1');        // tag_added humano NÃO entra na lista de removidas

  const f = await computeSticky(pool, { numberId: 1, identifier: 'c', opportunityId: opp });
  const sorted = [...f.tagsRemovedByHuman].sort();
  assert.deepEqual(sorted, ['VIP', 'urgente']);
});

test('opportunityId null → flags de opp false mesmo havendo eventos humanos', async () => {
  const opp = await insertOpp();
  await event(opp, 'qualification', 'qualificado', 'u1');
  await event(opp, 'tag_removed', 'VIP', 'u1');
  await logLead('c', 'u1'); // is_lead humano ainda trava

  const f = await computeSticky(pool, { numberId: 1, identifier: 'c', opportunityId: null });
  assert.equal(f.isLead, true);
  assert.equal(f.isQualified, false);
  assert.equal(f.status, false);
  assert.equal(f.lossReason, false);
  assert.deepEqual(f.tagsRemovedByHuman, []);
});

test('opp só com eventos de sistema → nada trava', async () => {
  const opp = await insertOpp();
  await event(opp, 'qualification', 'qualificado', 'system');
  await event(opp, 'status', 'perdido', 'ai');
  await event(opp, 'loss_reason', 'nao_lead', 'system');
  await event(opp, 'tag_removed', 'x', 'migration');

  const f = await computeSticky(pool, { numberId: 1, identifier: 'c', opportunityId: opp });
  assert.deepEqual(f, { isLead: false, isQualified: false, status: false, lossReason: false, tagsRemovedByHuman: [] });
});
